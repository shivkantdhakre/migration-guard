/**
 * credential-version-rotation.spec.ts
 *
 * P0.3 Verification: The worker must resolve the EXACT vault version pinned in
 * connections.credential_version, not the latest version.
 *
 * This test simulates the in-memory SQL logic of resolveConnectionFromVault():
 * - v1 credentials are in connection_secrets (version=1)
 * - v2 credentials are in connection_secrets (version=2)
 * - connections.credential_version = 2
 * - Worker must return v2 and NOT v1
 */

import { describe, it, expect } from 'vitest';

// ── Minimal in-memory simulation ───────────────────────────────────────────────

interface ConnectionRow {
  id: string;
  engine: string;
  config_json: Record<string, any>;
  credential_version: number;
}

interface SecretRow {
  connection_id: string;
  version: number;
  decrypted: string; // simulated already-decrypted credentials JSON
}

function resolveFromSimulatedVault(
  connections: ConnectionRow[],
  secrets: SecretRow[],
  connectionId: string,
): { engine: string; credentials: any; credentialVersion: number } | null {
  const conn = connections.find((c) => c.id === connectionId);
  if (!conn) return null;

  // P0.3: Join on exact credential_version, NOT ORDER BY version DESC
  const secret = secrets.find(
    (s) => s.connection_id === connectionId && s.version === conn.credential_version,
  );

  if (!secret) {
    throw new Error(
      `Vault record missing for connection ${connectionId} at pinned version ${conn.credential_version}`,
    );
  }

  return {
    engine: conn.engine,
    credentials: JSON.parse(secret.decrypted),
    credentialVersion: conn.credential_version,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('P0.3 — Credential version pinning', () => {
  const connections: ConnectionRow[] = [
    { id: 'conn-postgres-01', engine: 'POSTGRESQL', config_json: {}, credential_version: 2 },
  ];
  const secrets: SecretRow[] = [
    {
      connection_id: 'conn-postgres-01',
      version: 1,
      decrypted: JSON.stringify({ connectionString: 'postgresql://user:old_pass@host/db' }),
    },
    {
      connection_id: 'conn-postgres-01',
      version: 2,
      decrypted: JSON.stringify({ connectionString: 'postgresql://user:new_pass@host/db' }),
    },
  ];

  it('resolves the pinned version (v2), not the highest version', () => {
    const result = resolveFromSimulatedVault(connections, secrets, 'conn-postgres-01');
    expect(result).not.toBeNull();
    expect(result!.credentialVersion).toBe(2);
    expect(result!.credentials.connectionString).toContain('new_pass');
  });

  it('does NOT return v1 credentials when credential_version = 2', () => {
    const result = resolveFromSimulatedVault(connections, secrets, 'conn-postgres-01');
    expect(result!.credentials.connectionString).not.toContain('old_pass');
  });

  it('throws when no vault record exists for the pinned version', () => {
    const connsWithMissingVersion: ConnectionRow[] = [
      { id: 'conn-postgres-02', engine: 'POSTGRESQL', config_json: {}, credential_version: 3 },
    ];
    // Only v1 and v2 exist in secrets — v3 is missing
    expect(() =>
      resolveFromSimulatedVault(connsWithMissingVersion, secrets, 'conn-postgres-02'),
    ).toThrow(/pinned version 3/);
  });

  it('returns null for an unknown connectionId', () => {
    const result = resolveFromSimulatedVault(connections, secrets, 'nonexistent-connection');
    expect(result).toBeNull();
  });

  it('after rotation: credential_version bumped to 3 returns v3 credentials', () => {
    const rotatedConnections: ConnectionRow[] = [
      { id: 'conn-postgres-01', engine: 'POSTGRESQL', config_json: {}, credential_version: 3 },
    ];
    const secretsWithV3: SecretRow[] = [
      ...secrets,
      {
        connection_id: 'conn-postgres-01',
        version: 3,
        decrypted: JSON.stringify({ connectionString: 'postgresql://user:rotated_pass@host/db' }),
      },
    ];
    const result = resolveFromSimulatedVault(rotatedConnections, secretsWithV3, 'conn-postgres-01');
    expect(result!.credentialVersion).toBe(3);
    expect(result!.credentials.connectionString).toContain('rotated_pass');
  });
});
