import { DatabaseService } from '../src/database/database.service';

export interface ResolvedRedisTarget {
  host: string;
  port: string;
  url: string;
  isLoopback: boolean;
  isDesignatedTestUrl: boolean;
  source: string;
}

/**
 * Creates an immutable snapshot of process.env and returns a restoration function.
 * Restoring deletes keys that were originally absent (preventing 'undefined' string pollution)
 * and restores original values for keys that existed.
 */
export function snapshotEnv(): () => void {
  const snapshot = { ...process.env };
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
  };
}

/**
 * Resolves and strictly validates the Redis endpoint to be used for testing.
 *
 * Rules:
 * 1. Testing in production (NODE_ENV=production or REDIS_ENV=production) is unconditionally forbidden.
 * 2. Remote endpoints strictly require:
 *    a) Designated MIGRATIONGUARD_TEST_REDIS_URL or TEST_REDIS_URL (valid URL with redis: or rediss: protocol).
 *    b) Non-production hostname (rejected if matches /prod/i).
 *    c) Explicit operator approval: ALLOW_REMOTE_TEST_REDIS=true.
 *    d) Exact hostname presence in MIGRATIONGUARD_ALLOWED_TEST_REDIS_HOSTS allowlist.
 * 3. Generic application REDIS_URL or REDIS_HOST can ONLY be used if verified as a local loopback host.
 *    Generic URLs are NEVER permitted for remote testing, even if ALLOW_REMOTE_TEST_REDIS=true.
 */
export function resolveSafeTestRedisEndpoint(): ResolvedRedisTarget {
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    process.env.REDIS_ENV === 'production';

  if (isProduction) {
    throw new Error('[Safety Guard] Redis tests must never run in production environment (NODE_ENV/REDIS_ENV=production).');
  }

  const designatedTestUrl =
    process.env.MIGRATIONGUARD_TEST_REDIS_URL || process.env.TEST_REDIS_URL;

  if (designatedTestUrl) {
    let parsed: URL;
    try {
      parsed = new URL(designatedTestUrl);
    } catch {
      throw new Error(
        `[Safety Guard] Invalid designated test Redis URL format: '${designatedTestUrl}'. A valid URL is required.`,
      );
    }

    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(
        `[Safety Guard] Unsupported Redis protocol '${parsed.protocol}'. Only 'redis:' and 'rediss:' are accepted.`,
      );
    }

    const host = parsed.hostname;
    if (!host) {
      throw new Error(`[Safety Guard] Missing hostname in designated test Redis URL: '${designatedTestUrl}'.`);
    }

    const port = parsed.port || (parsed.protocol === 'rediss:' ? '6380' : '6379');
    const isLoopback = DatabaseService.isLoopbackHost(host);

    if (!isLoopback) {
      // 1. Strict production pattern guard
      if (/prod/i.test(host) || /prod/i.test(designatedTestUrl)) {
        throw new Error(
          `[Safety Guard] Designated test Redis URL (${host}) matches production naming patterns (/prod/i). ` +
          `Testing against production endpoints is strictly forbidden.`,
        );
      }

      // 2. Strict remote approval guard
      if (process.env.ALLOW_REMOTE_TEST_REDIS !== 'true') {
        throw new Error(
          `[Safety Guard] Refusing to connect to remote test Redis (${host}) without explicit ALLOW_REMOTE_TEST_REDIS=true.`,
        );
      }

      // 3. Strict host allowlist guard
      const allowedHosts = (process.env.MIGRATIONGUARD_ALLOWED_TEST_REDIS_HOSTS || '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);

      if (!allowedHosts.includes(host.toLowerCase())) {
        throw new Error(
          `[Safety Guard] Remote Redis host '${host}' is not present in MIGRATIONGUARD_ALLOWED_TEST_REDIS_HOSTS allowlist. Refusing execution.`,
        );
      }
    }

    return {
      host,
      port,
      url: designatedTestUrl,
      isLoopback,
      isDesignatedTestUrl: true,
      source: process.env.MIGRATIONGUARD_TEST_REDIS_URL ? 'MIGRATIONGUARD_TEST_REDIS_URL' : 'TEST_REDIS_URL',
    };
  }

  // If no designated test URL, inspect generic application REDIS_URL / REDIS_HOST
  let genericHost = 'localhost';
  let genericPort = '6379';
  let genericUrl: string | undefined = undefined;

  if (process.env.REDIS_URL) {
    let parsed: URL;
    try {
      parsed = new URL(process.env.REDIS_URL);
    } catch {
      throw new Error(`[Safety Guard] Invalid generic REDIS_URL format: '${process.env.REDIS_URL}'.`);
    }

    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(`[Safety Guard] Unsupported generic REDIS_URL protocol: '${parsed.protocol}'.`);
    }

    genericHost = parsed.hostname;
    genericPort = parsed.port || (parsed.protocol === 'rediss:' ? '6380' : '6379');
    genericUrl = process.env.REDIS_URL;
  } else if (process.env.REDIS_HOST) {
    genericHost = process.env.REDIS_HOST;
    genericPort = String(process.env.REDIS_PORT || '6379');
  }

  const isGenericLoopback = DatabaseService.isLoopbackHost(genericHost);

  // CRITICAL SAFETY RULE: Generic REDIS_URL / REDIS_HOST is strictly rejected if remote,
  // EVEN IF ALLOW_REMOTE_TEST_REDIS=true. Remote testing strictly requires MIGRATIONGUARD_TEST_REDIS_URL.
  if (!isGenericLoopback) {
    throw new Error(
      `[Safety Guard] Generic application Redis endpoint (${genericHost}) cannot be used for remote testing. ` +
      `Designated MIGRATIONGUARD_TEST_REDIS_URL is required for remote test execution.`,
    );
  }

  if (/prod/i.test(genericHost) || (genericUrl && /prod/i.test(genericUrl))) {
    throw new Error(
      `[Safety Guard] Redis endpoint (${genericHost}) matches production naming patterns (/prod/i). Execution rejected.`,
    );
  }

  const url = genericUrl || `redis://${genericHost}:${genericPort}`;
  return {
    host: genericHost,
    port: genericPort,
    url,
    isLoopback: true,
    isDesignatedTestUrl: false,
    source: process.env.REDIS_URL ? 'REDIS_URL' : 'REDIS_HOST',
  };
}

export interface ResolvedDatabaseTarget {
  host: string;
  port: string;
  dbName: string;
  url: string;
  isLoopback: boolean;
}

/**
 * Validates that a target database URL is safe for test execution.
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

  const isLoopback = DatabaseService.isLoopbackHost(host);

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
