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
 * Resolves and strictly validates the Redis endpoint to be used for testing.
 *
 * Rules:
 * 1. Testing in production (NODE_ENV=production or REDIS_ENV=production) is unconditionally forbidden.
 * 2. Remote endpoints strictly require designated MIGRATIONGUARD_TEST_REDIS_URL or TEST_REDIS_URL
 *    AND explicit ALLOW_REMOTE_TEST_REDIS=true.
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
    let host = '';
    let port = '6379';
    try {
      const parsed = new URL(designatedTestUrl);
      host = parsed.hostname;
      port = parsed.port || '6379';
    } catch {
      host = designatedTestUrl;
    }

    const isLoopback = DatabaseService.isLoopbackHost(host);
    if (!isLoopback && process.env.ALLOW_REMOTE_TEST_REDIS !== 'true') {
      throw new Error(
        `[Safety Guard] Refusing to connect to remote test Redis (${host}) without explicit ALLOW_REMOTE_TEST_REDIS=true.`,
      );
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
    try {
      const parsed = new URL(process.env.REDIS_URL);
      genericHost = parsed.hostname;
      genericPort = parsed.port || '6379';
      genericUrl = process.env.REDIS_URL;
    } catch {
      genericHost = process.env.REDIS_URL;
    }
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
