export function normalizeIpHost(host: string): string {
  if (!host) return '';
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase().trim();

  // Handle IPv4-mapped IPv6 in hex: e.g. ::ffff:7f00:1 or 0:0:0:0:0:ffff:7f00:1
  const ipv4MappedHex = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(clean);
  if (ipv4MappedHex) {
    const high = parseInt(ipv4MappedHex[1], 16);
    const low = parseInt(ipv4MappedHex[2], 16);
    const b1 = (high >> 8) & 0xff;
    const b2 = high & 0xff;
    const b3 = (low >> 8) & 0xff;
    const b4 = low & 0xff;
    return `${b1}.${b2}.${b3}.${b4}`;
  }

  // Handle IPv4-mapped IPv6 in dotted decimal: ::ffff:127.0.0.1
  const ipv4MappedDot = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(clean);
  if (ipv4MappedDot) {
    return ipv4MappedDot[1];
  }

  // Handle fully expanded IPv6 loopback and unspecified
  if (/^(0+:){7}0*1$/.test(clean)) {
    return '::1';
  }
  if (/^(0+:){7}0*0$/.test(clean)) {
    return '::';
  }

  return clean;
}

export const isLoopbackHost = (host: string): boolean => {
  if (!host) return false;
  const normalized = normalizeIpHost(host);
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  );
};

export const isUnspecifiedHost = (host: string): boolean => {
  if (!host) return false;
  const normalized = normalizeIpHost(host);
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

  // 1. Strict production pattern guard (applies UNCONDITIONALLY to all endpoints, local and remote alike)
  if (/prod/i.test(host) || /prod/i.test(targetDbUrl) || /prod/i.test(dbName)) {
    throw new Error(
      `[Safety Guard] Designated test database (${host}/${dbName}) matches production naming patterns (/prod/i). ` +
      `Testing against production endpoints is strictly forbidden.`,
    );
  }

  const isLoopback = isLoopbackHost(host);

  if (!isLoopback) {
    // 2. Strict remote approval guard
    if (process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
      throw new Error(
        `[Safety Guard] Refusing to connect to remote test database (${host}) without explicit ALLOW_REMOTE_TEST_DB=true.`,
      );
    }

    // 3. Strict host allowlist guard (MANDATORY for remote endpoints)
    const allowedHosts = (process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

    if (allowedHosts.length === 0) {
      throw new Error(
        `[Safety Guard] Remote database testing strictly requires a non-empty MIGRATIONGUARD_ALLOWED_TEST_DATABASE_HOSTS allowlist. Refusing execution.`,
      );
    }

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

    // 5. Port validation against MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS (MANDATORY for remote endpoints)
    const allowedPorts = (process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    if (allowedPorts.length === 0) {
      throw new Error(
        `[Safety Guard] Remote database testing strictly requires a non-empty MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS allowlist. Refusing execution.`,
      );
    }

    if (!allowedPorts.includes(port)) {
      throw new Error(
        `[Safety Guard] Remote database port '${port}' is not present in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS allowlist. Refusing execution.`,
      );
    }

    // 6. Target tuple authorization against MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS (MANDATORY for remote endpoints)
    const allowedTargets = (process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    if (allowedTargets.length === 0) {
      throw new Error(
        `[Safety Guard] Remote database testing strictly requires a non-empty MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS allowlist. Refusing execution.`,
      );
    }

    const targetTuple = `${host.toLowerCase()}:${port}/${dbName.toLowerCase()}`;
    if (!allowedTargets.includes(targetTuple)) {
      throw new Error(
        `[Safety Guard] Remote database target tuple '${targetTuple}' is not present in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS allowlist. Refusing execution.`,
      );
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

export interface ResolvedMongoTarget {
  host: string;
  dbName: string;
  url: string;
  isLoopback: boolean;
}

/**
 * Validates that a target MongoDB URL is safe for worker test execution.
 * Rejects production environments, /prod/i patterns, and remote endpoints without explicit allowlisting.
 */
export function validateSafeTestMongoEndpoint(targetMongoUrl: string): ResolvedMongoTarget {
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    process.env.MONGO_ENV === 'production';

  if (isProduction) {
    throw new Error('[Safety Guard] Live MongoDB integration tests must never run in production environment.');
  }

  if (!targetMongoUrl || !targetMongoUrl.trim()) {
    throw new Error('[Safety Guard] Designated test MongoDB URL is missing or empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(targetMongoUrl);
  } catch {
    throw new Error(`[Safety Guard] Invalid designated test MongoDB URL format: '${targetMongoUrl}'.`);
  }

  if (parsed.protocol !== 'mongodb:' && parsed.protocol !== 'mongodb+srv:') {
    throw new Error(`[Safety Guard] Unsupported MongoDB protocol '${parsed.protocol}'.`);
  }

  const host = parsed.hostname;
  if (!host) {
    throw new Error(`[Safety Guard] Missing hostname in designated test MongoDB URL.`);
  }

  const dbName = (parsed.pathname || '').replace(/^\//, '').split('?')[0].trim();

  if (/prod/i.test(host) || /prod/i.test(targetMongoUrl) || (dbName && /prod/i.test(dbName))) {
    throw new Error(
      `[Safety Guard] Designated test MongoDB endpoint (${host}/${dbName || 'default'}) matches production naming patterns (/prod/i). Testing refused.`,
    );
  }

  const isLoopback = isLoopbackHost(host);
  if (!isLoopback) {
    if (process.env.ALLOW_REMOTE_TEST_MONGO !== 'true') {
      throw new Error(
        `[Safety Guard] Refusing to connect to remote test MongoDB (${host}) without explicit ALLOW_REMOTE_TEST_MONGO=true.`,
      );
    }

    const allowedHosts = (process.env.MIGRATIONGUARD_ALLOWED_TEST_MONGO_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

    if (allowedHosts.length === 0 || !allowedHosts.includes(host.toLowerCase())) {
      throw new Error(
        `[Safety Guard] Remote MongoDB host '${host}' is not present in MIGRATIONGUARD_ALLOWED_TEST_MONGO_HOSTS allowlist. Execution refused.`,
      );
    }
  }

  return {
    host,
    dbName,
    url: targetMongoUrl,
    isLoopback,
  };
}

export interface ResolvedRedisTarget {
  host: string;
  port: string;
  url: string;
  isLoopback: boolean;
}

/**
 * Validates that a target Redis URL is safe for worker test execution.
 * Rejects production environments, /prod/i patterns, and remote endpoints without explicit allowlisting.
 */
export function validateSafeTestRedisEndpoint(targetRedisUrl: string): ResolvedRedisTarget {
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    process.env.REDIS_ENV === 'production';

  if (isProduction) {
    throw new Error('[Safety Guard] Live Redis integration tests must never run in production environment.');
  }

  if (!targetRedisUrl || !targetRedisUrl.trim()) {
    throw new Error('[Safety Guard] Designated test Redis URL is missing or empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(targetRedisUrl);
  } catch {
    throw new Error(`[Safety Guard] Invalid designated test Redis URL format: '${targetRedisUrl}'.`);
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`[Safety Guard] Unsupported Redis protocol '${parsed.protocol}'.`);
  }

  const host = parsed.hostname;
  if (!host) {
    throw new Error(`[Safety Guard] Missing hostname in designated test Redis URL.`);
  }

  const port = parsed.port || (parsed.protocol === 'rediss:' ? '6380' : '6379');

  if (/prod/i.test(host) || /prod/i.test(targetRedisUrl)) {
    throw new Error(
      `[Safety Guard] Designated test Redis endpoint (${host}) matches production naming patterns (/prod/i). Testing refused.`,
    );
  }

  const isLoopback = isLoopbackHost(host);
  if (!isLoopback) {
    if (process.env.ALLOW_REMOTE_TEST_REDIS !== 'true') {
      throw new Error(
        `[Safety Guard] Refusing to connect to remote test Redis (${host}) without explicit ALLOW_REMOTE_TEST_REDIS=true.`,
      );
    }

    const allowedHosts = (process.env.MIGRATIONGUARD_ALLOWED_TEST_REDIS_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

    if (allowedHosts.length === 0 || !allowedHosts.includes(host.toLowerCase())) {
      throw new Error(
        `[Safety Guard] Remote Redis host '${host}' is not present in MIGRATIONGUARD_ALLOWED_TEST_REDIS_HOSTS allowlist. Execution refused.`,
      );
    }
  }

  return {
    host,
    port,
    url: targetRedisUrl,
    isLoopback,
  };
}
