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

export const isUnspecifiedHost = (host: string): boolean => {
  if (!host) return false;
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase().trim();
  return normalized === '0.0.0.0' || normalized === '::';
};

export const isUnsafeProductionHost = (host: string): boolean => {
  return isLoopbackHost(host) || isUnspecifiedHost(host);
};

export interface ResolvedDatabaseTarget {
  host: string;
  port: string;
  dbName: string;
  url: string;
  isLoopback: boolean;
}

/**
 * Validates that a target database URL is safe for worker test execution.
 *
 * Rules:
 * 1. Testing in production (NODE_ENV=production or DATABASE_ENV=production) is unconditionally forbidden.
 * 2. URL must be valid postgres: or postgresql: protocol.
 * 3. Database name (dbName) must be valid and non-empty.
 * 4. When connecting to a remote endpoint (!isLoopbackHost):
 *    a) Production patterns (/prod/i) in host, url, or dbName are strictly forbidden.
 *    b) Explicit operator approval is mandatory: ALLOW_REMOTE_TEST_DB=true.
 *    c) Hostname must be in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_HOSTS allowlist.
 *    d) MIGRATIONGUARD_ALLOWED_TEST_DATABASE_NAMES must be non-empty and dbName must be explicitly listed.
 *    e) If MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS is configured, port must be explicitly listed.
 *    f) If MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS is configured, host:port/dbName tuple must be listed.
 */
export function validateSafeTestDatabaseEndpoint(targetDbUrl: string): ResolvedDatabaseTarget {
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    process.env.DATABASE_ENV === 'production';

  if (isProduction) {
    throw new Error('[Safety Guard] Live PostgreSQL integration tests must never run in production environment (NODE_ENV/DATABASE_ENV=production).');
  }

  if (!targetDbUrl || !targetDbUrl.trim()) {
    throw new Error('[Safety Guard] Designated test database URL is missing or empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(targetDbUrl);
  } catch {
    throw new Error(`[Safety Guard] Invalid designated test database URL format: '${targetDbUrl}'. A valid URL is required.`);
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`[Safety Guard] Unsupported database protocol '${parsed.protocol}'. Only 'postgres:' and 'postgresql:' are accepted.`);
  }

  const host = parsed.hostname;
  if (!host) {
    throw new Error(`[Safety Guard] Missing hostname in designated test database URL: '${targetDbUrl}'.`);
  }

  const port = parsed.port || '5432';
  const rawPath = (parsed.pathname || '').replace(/^\//, '').split('?')[0].trim();
  const dbName = rawPath;

  if (!dbName) {
    throw new Error(`[Safety Guard] Target test database URL must specify a non-empty database name: '${targetDbUrl}'.`);
  }

  const isLoopback = isLoopbackHost(host);

  if (!isLoopback) {
    // 1. Strict production pattern guard
    if (/prod/i.test(host) || /prod/i.test(targetDbUrl) || /prod/i.test(dbName)) {
      throw new Error(
        `[Safety Guard] Designated test database (${host}/${dbName}) matches production naming patterns (/prod/i). ` +
        `Testing against production endpoints is strictly forbidden.`,
      );
    }

    // 2. Strict remote approval guard
    if (process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
      throw new Error(
        `[Safety Guard] Refusing to connect to remote test database (${host}) without explicit ALLOW_REMOTE_TEST_DB=true.`,
      );
    }

    // 3. Strict host allowlist guard
    const allowedHosts = (process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

    if (!allowedHosts.includes(host.toLowerCase())) {
      throw new Error(
        `[Safety Guard] Remote database host '${host}' is not present in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_HOSTS allowlist. Refusing execution.`,
      );
    }

    // 4. Strict mandatory database name allowlist guard (MANDATORY for remote endpoints)
    const allowedNames = (process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_NAMES || '')
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);

    if (allowedNames.length === 0) {
      throw new Error(
        `[Safety Guard] Remote database testing strictly requires a non-empty MIGRATIONGUARD_ALLOWED_TEST_DATABASE_NAMES allowlist. Refusing execution.`,
      );
    }

    if (!allowedNames.includes(dbName.toLowerCase())) {
      throw new Error(
        `[Safety Guard] Remote database name '${dbName}' is not present in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_NAMES allowlist. Refusing execution.`,
      );
    }

    // 5. Port validation against MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS (if configured)
    const allowedPorts = (process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    if (allowedPorts.length > 0 && !allowedPorts.includes(port)) {
      throw new Error(
        `[Safety Guard] Remote database port '${port}' is not present in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS allowlist. Refusing execution.`,
      );
    }

    // 6. Target tuple authorization against MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS (if configured)
    const allowedTargets = (process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    if (allowedTargets.length > 0) {
      const targetTuple = `${host.toLowerCase()}:${port}/${dbName.toLowerCase()}`;
      if (!allowedTargets.includes(targetTuple)) {
        throw new Error(
          `[Safety Guard] Remote database target tuple '${targetTuple}' is not present in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS allowlist. Refusing execution.`,
        );
      }
    }
  }

  return {
    host,
    port,
    dbName,
    url: targetDbUrl,
    isLoopback,
  };
}
