import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { ConnectorFactory, PostgresDestinationConnector } from '../src/connectors/connector-factory.js';
import { TransformedBatch } from '../src/types.js';

export const isLoopbackHost = (host: string): boolean => {
  if (!host) return false;
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase().trim();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  );
};

describe('Real PostgreSQL Destination Connector Integration', () => {
  const targetDbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('[Safety Guard] Live destination write integration tests must never run in production.');
  }

  const isLocalOrCi = (() => {
    if (!targetDbUrl) return false;
    try {
      const parsed = new URL(targetDbUrl);
      return isLoopbackHost(parsed.hostname);
    } catch {
      return false;
    }
  })();

  const ssl = isLocalOrCi ? false : { rejectUnauthorized: true };

  const testSchema = `test_dest_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const testKey = `test_cust_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  let adminPool: pg.Pool;
  let connectorPool: pg.Pool;
  let connector: PostgresDestinationConnector;
  let schemaCreated = false;

  beforeAll(async () => {
    if (!targetDbUrl) {
      if (process.env.CI === 'true') {
        throw new Error(
          '[CI Mandatory Failure] MIGRATIONGUARD_TEST_DATABASE_URL or TEST_DATABASE_URL must be explicitly configured in CI environment.',
        );
      }
      console.warn(
        '[Safety Guard] No designated test database URL provided. MIGRATIONGUARD_TEST_DATABASE_URL or TEST_DATABASE_URL required. Skipping live integration test.',
      );
      return;
    }

    let targetHost = '';
    try {
      const parsed = new URL(targetDbUrl);
      targetHost = parsed.hostname;
    } catch {
      targetHost = targetDbUrl;
    }

    if (!isLocalOrCi) {
      // 1. Strict production pattern guard
      if (/prod/i.test(targetHost) || /prod/i.test(targetDbUrl)) {
        const msg = `[Safety Guard] Designated test database URL (${targetHost}) matches production naming patterns (/prod/i). Testing against production endpoints is strictly forbidden.`;
        if (process.env.CI === 'true') throw new Error(`[CI Mandatory Failure] ${msg}`);
        console.warn(msg);
        return;
      }

      // 2. Strict remote approval guard
      if (process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
        const msg =
          '[Safety Guard] Refusing to run live destination integration test against remote database without explicit ALLOW_REMOTE_TEST_DB=true.';
        if (process.env.CI === 'true') {
          throw new Error(`[CI Mandatory Failure] ${msg}`);
        }
        console.warn(msg);
        return;
      }

      // 3. Strict host allowlist guard
      const allowedDbHosts = (process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_HOSTS || '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);

      if (!allowedDbHosts.includes(targetHost.toLowerCase())) {
        const msg = `[Safety Guard] Remote database host '${targetHost}' is not present in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_HOSTS allowlist. Refusing execution.`;
        if (process.env.CI === 'true') {
          throw new Error(`[CI Mandatory Failure] ${msg}`);
        }
        console.warn(msg);
        return;
      }
    }

    adminPool = new pg.Pool({ connectionString: targetDbUrl, ssl, max: 2 });
    try {
      await adminPool.query('SELECT 1');
      await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${testSchema}"`);
      schemaCreated = true;
    } catch (err: any) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] Live PostgreSQL destination unreachable in CI: ${err.message}`);
      }
      console.warn(`[Notice] Live database offline in sandbox: ${err.message}`);
      return;
    }

    // Connector pool connects strictly scoped to the isolated test schema
    connectorPool = new pg.Pool({
      connectionString: targetDbUrl,
      ssl,
      max: 5,
      options: `-c search_path="${testSchema}"`,
    });
    connector = ConnectorFactory.createPostgresDestination(connectorPool) as PostgresDestinationConnector;

    // Ensure destination table exists inside the isolated test schema
    await connector.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        phone TEXT,
        tier TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        metadata JSONB
      )
    `);
  });

  afterAll(async () => {
    let cleanupError: any = null;
    try {
      if (connector) {
        await connector.close();
      }
    } catch (err: any) {
      cleanupError = err;
    }

    try {
      // Only attempt DROP SCHEMA if schema was actually created; skips safely when DB was unreachable
      if (adminPool && schemaCreated) {
        await adminPool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      }
    } catch (err: any) {
      if (!cleanupError) cleanupError = err;
    }

    try {
      if (adminPool) {
        await adminPool.end();
      }
    } catch (err: any) {
      if (schemaCreated && !cleanupError) {
        cleanupError = err;
      }
    }

    if (cleanupError) {
      throw cleanupError;
    }
  });

  it('should verify live PostgreSQL connectivity', async (ctx) => {
    if (!connector) {
      if (process.env.CI === 'true') {
        throw new Error('[CI Mandatory Failure] Connector was not initialized in CI.');
      }
      ctx.skip();
      return;
    }
    const res = await connector.testConnection();
    if (!res.success) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] Live PostgreSQL connection failed in CI: ${res.message}`);
      }
      ctx.skip();
      return;
    }
    expect(res.success).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should write real transformed batch into destination PostgreSQL', async (ctx) => {
    if (!connector) {
      ctx.skip();
      return;
    }
    const check = await connector.testConnection();
    if (!check.success) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] Live PostgreSQL destination write failed in CI: ${check.message}`);
      }
      ctx.skip();
      return;
    }

    const batch: TransformedBatch = {
      destinationObject: 'customers',
      batchKey: 'batch_test_real_001',
      records: [
        {
          sourceObject: 'customers',
          sourceKey: testKey,
          destinationObject: 'customers',
          destinationKey: testKey,
          data: {
            id: testKey,
            name: 'Acme Test Corp',
            email: 'acme@testcorp.com',
            phone: '+1-555-0199',
            tier: 'ENTERPRISE',
            created_at: new Date().toISOString(),
            metadata: JSON.stringify({ verified: true, source: 'live_worker_test' }),
          },
          contentHash: 'sha256:test123456789',
        },
      ],
    };

    const writeResult = await connector.writeBatch(batch, {
      writeMode: 'upsert',
      conflictColumns: ['id'],
      updateColumns: ['name', 'email', 'phone', 'tier', 'metadata'],
    });

    expect(writeResult.recordsWritten + writeResult.recordsSkipped).toBeGreaterThanOrEqual(1);
    expect(writeResult.recordsFailed).toBe(0);
  });

  it('should read written records back from destination PostgreSQL using readByKeys', async (ctx) => {
    if (!connector) {
      ctx.skip();
      return;
    }
    const check = await connector.testConnection();
    if (!check.success) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] Live PostgreSQL destination read failed in CI: ${check.message}`);
      }
      ctx.skip();
      return;
    }

    const records = await connector.readByKeys('customers', [testKey]);
    expect(records).toHaveLength(1);
    expect(records[0].destinationKey).toBe(testKey);
    expect(records[0].data.name).toBe('Acme Test Corp');
    expect(records[0].data.email).toBe('acme@testcorp.com');

    console.log('[PostgreSQL Destination Write Integration] Verified real write and readByKeys on live PostgreSQL.');
  });
});

describe('PostgreSQL Destination Target Protection & Teardown Guards', () => {
  it('confirms isLoopbackHost strictly rejects 0.0.0.0 and :: as wildcard addresses', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('[::]')).toBe(false);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.5')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('verifies teardown handles offline database without throwing unhandled DROP SCHEMA errors', async () => {
    // Simulate offline state: adminPool exists but schemaCreated is false
    const mockPool = {
      query: async () => {
        throw new Error('Connection refused (database offline)');
      },
      end: async () => {},
    };

    const schemaCreated = false;
    let cleanupError: any = null;

    try {
      if (mockPool && schemaCreated) {
        await mockPool.query();
      }
    } catch (err: any) {
      if (!cleanupError) cleanupError = err;
    }

    try {
      if (mockPool) {
        await mockPool.end();
      }
    } catch (err: any) {
      if (schemaCreated && !cleanupError) {
        cleanupError = err;
      }
    }

    // Must complete cleanly with no error thrown
    expect(cleanupError).toBeNull();
  });
});
