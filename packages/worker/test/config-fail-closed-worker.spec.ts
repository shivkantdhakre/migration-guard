import { describe, expect, it, afterEach } from 'vitest';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { validateDestinationConnectionString } from '../src/worker-main.js';
import { resolvePostgresSsl } from '../src/connectors/connector-factory.js';
import {
  validateSafeTestDatabaseEndpoint,
  validateSafeTestMongoEndpoint,
  validateSafeTestRedisEndpoint,
} from './helpers/postgres-test-utils.js';

const execAsync = promisify(exec);

describe('Worker Configuration Fail-Closed Security (P1 & Run 005.1)', { timeout: 35000 }, () => {
  const repoRoot = path.resolve(__dirname, '../../..');

  const runNodeCmd = async (cmd: string): Promise<{ failed: boolean; errorMessage: string }> => {
    try {
      await execAsync(cmd, { cwd: repoRoot, timeout: 25000 });
      return { failed: false, errorMessage: '' };
    } catch (err: any) {
      const stderr = err.stderr ? err.stderr.toString() : '';
      const stdout = err.stdout ? err.stdout.toString() : '';
      return { failed: true, errorMessage: stderr || stdout || err.message };
    }
  };

  it('fails startup in production when DATABASE_URL is missing or empty', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL=''; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost/);
  });

  it('fails startup in production when DATABASE_URL points to localhost', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://postgres:pass@localhost:5432/db'; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost or loopback/);
  });

  it('fails startup in production when DATABASE_URL points to IPv6 loopback [::1]', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://postgres:pass@[::1]:5432/db'; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost or loopback/);
  });

  it('fails startup in production when ALLOW_SYNTHETIC_SOURCE is true', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.ALLOW_SYNTHETIC_SOURCE='true'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/Synthetic source execution \(ALLOW_SYNTHETIC_SOURCE=true\) is strictly forbidden in production/);
  });

  it('fails startup in production when REDIS_URL and remote REDIS_HOST are missing', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL=''; process.env.REDIS_HOST='localhost'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL or remote non-loopback REDIS_HOST must be explicitly configured/);
  });

  it('fails startup in production when REDIS_URL points to localhost', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://localhost:6379'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL cannot point to loopback\/localhost/);
  });

  it('fails startup in production when REDIS_URL points to 127.0.0.1', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://127.0.0.1:6379'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL cannot point to loopback\/localhost/);
  });

  it('fails startup in production when REDIS_URL points to IPv6 loopback [::1]', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://[::1]:6379'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL cannot point to loopback\/localhost/);
  });

  it('fails startup in production when REDIS_URL does not use TLS (rediss://)', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='redis://valkey.cloud.provider:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL must use TLS \('rediss:\/\/'\)/);
  });

  it('fails startup in production when DATABASE_URL points to wildcard 0.0.0.0', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://postgres:pass@0.0.0.0:5432/db'; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost or loopback/);
  });

  it('fails startup in production when DATABASE_URL points to wildcard IPv6 [::]', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://postgres:pass@[::]:5432/db'; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost or loopback/);
  });

  it('fails startup in production when REDIS_URL points to wildcard 0.0.0.0', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://0.0.0.0:6379'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL cannot point to loopback\/localhost/);
  });

  it('fails startup in production when REDIS_URL points to wildcard IPv6 [::]', async () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://[::]:6379'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = await runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL cannot point to loopback\/localhost/);
  });

  it('fails startup in production when REDIS_HOST points to wildcard 0.0.0.0 or ::', async () => {
    const cmd1 = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL=''; process.env.REDIS_HOST='0.0.0.0'; require('./packages/worker/dist/worker-main.js');"`;
    const res1 = await runNodeCmd(cmd1);
    expect(res1.failed).toBe(true);
    expect(res1.errorMessage).toMatch(/REDIS_URL or remote non-loopback REDIS_HOST must be explicitly configured/);

    const cmd2 = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL=''; process.env.REDIS_HOST='::'; require('./packages/worker/dist/worker-main.js');"`;
    const res2 = await runNodeCmd(cmd2);
    expect(res2.failed).toBe(true);
    expect(res2.errorMessage).toMatch(/REDIS_URL or remote non-loopback REDIS_HOST must be explicitly configured/);
  });

  describe('Vault Destination Host Runtime Safety & Safe Test Endpoint Validation (Run 005.12)', () => {
    const origEnv = { ...process.env };

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in origEnv)) {
          delete process.env[key];
        }
      }
      for (const [key, value] of Object.entries(origEnv)) {
        process.env[key] = value;
      }
    });

    it('rejects destination connection strings with loopback or wildcard addresses in production', () => {
      process.env.NODE_ENV = 'production';

      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@localhost:5432/dest', 'conn-1');
      }).toThrow(/cannot point to localhost, loopback, or wildcard addresses \(localhost\)/);

      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@127.0.0.1:5432/dest', 'conn-2');
      }).toThrow(/cannot point to localhost, loopback, or wildcard addresses \(127\.0\.0\.1\)/);

      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@[::1]:5432/dest', 'conn-3');
      }).toThrow(/cannot point to localhost, loopback, or wildcard addresses \(\[::1\]\)/);

      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@0.0.0.0:5432/dest', 'conn-4');
      }).toThrow(/cannot point to localhost, loopback, or wildcard addresses \(0\.0\.0\.0\)/);

      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@[::]:5432/dest', 'conn-5');
      }).toThrow(/cannot point to localhost, loopback, or wildcard addresses \(\[::\]\)/);

      // IPv4-mapped IPv6 loopback and wildcard aliases (Run 005.13 P1)
      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@[::ffff:127.0.0.1]:5432/dest', 'conn-6');
      }).toThrow(/cannot point to localhost, loopback, or wildcard addresses/);

      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@[::ffff:7f00:1]:5432/dest', 'conn-7');
      }).toThrow(/cannot point to localhost, loopback, or wildcard addresses/);

      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@::ffff:127.0.0.1:5432/dest', 'conn-8');
      }).toThrow(/cannot point to localhost, loopback, or wildcard addresses/);

      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@[::ffff:0:0]:5432/dest', 'conn-9');
      }).toThrow(/cannot point to localhost, loopback, or wildcard addresses/);

      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@[::ffff:0.0.0.0]:5432/dest', 'conn-10');
      }).toThrow(/cannot point to localhost, loopback, or wildcard addresses/);
    });

    it('allows valid remote destination connection strings in production', () => {
      process.env.NODE_ENV = 'production';
      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@remote-db.cloud.provider:5432/dest_catalog', 'conn-ok');
      }).not.toThrow();
    });

    it('allows loopback destination connection strings in test and development environments', () => {
      process.env.NODE_ENV = 'test';
      expect(() => {
        validateDestinationConnectionString('postgresql://postgres:pass@localhost:5432/test_dest', 'conn-dev');
      }).not.toThrow();
    });

    it('rejects empty or invalid destination connection strings', () => {
      expect(() => {
        validateDestinationConnectionString('', 'conn-empty');
      }).toThrow(/has an empty connection string/);

      expect(() => {
        validateDestinationConnectionString('invalid-conn-string', 'conn-bad');
      }).toThrow(/invalid connection string format/);
    });

    it('enforces resolvePostgresSsl production hostname restrictions', () => {
      process.env.NODE_ENV = 'production';
      expect(() => {
        resolvePostgresSsl('postgresql://postgres:pass@localhost:5432/db');
      }).toThrow(/PostgreSQL connection cannot point to localhost, loopback, or wildcard addresses/);

      expect(() => {
        resolvePostgresSsl('postgresql://postgres:pass@0.0.0.0:5432/db');
      }).toThrow(/PostgreSQL connection cannot point to localhost, loopback, or wildcard addresses/);

      expect(() => {
        resolvePostgresSsl('postgresql://postgres:pass@[::]:5432/db');
      }).toThrow(/PostgreSQL connection cannot point to localhost, loopback, or wildcard addresses/);

      expect(() => {
        resolvePostgresSsl('postgresql://postgres:pass@[::ffff:127.0.0.1]:5432/db');
      }).toThrow(/PostgreSQL connection cannot point to localhost, loopback, or wildcard addresses/);

      expect(() => {
        resolvePostgresSsl('postgresql://postgres:pass@[::ffff:7f00:1]:5432/db');
      }).toThrow(/PostgreSQL connection cannot point to localhost, loopback, or wildcard addresses/);

      process.env.NODE_ENV = 'test';
      expect(resolvePostgresSsl('postgresql://postgres:pass@localhost:5432/db')).toBe(false);
    });

    it('enforces worker validateSafeTestDatabaseEndpoint mandatory allowlists', () => {
      process.env.NODE_ENV = 'test';
      // Reject empty database name
      expect(() => {
        validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@remote.net:5432');
      }).toThrow(/must specify a non-empty database name/);

      // Reject local database with production naming pattern (Run 005.13 P2)
      expect(() => {
        validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@localhost:5432/production');
      }).toThrow(/matches production naming patterns/);

      expect(() => {
        validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@127.0.0.1:5432/prod_catalog');
      }).toThrow(/matches production naming patterns/);

      // Reject remote without ALLOW_REMOTE_TEST_DB
      process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_HOSTS = 'remote.net';
      process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_NAMES = 'test_db';
      process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS = '5432';
      process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS = 'remote.net:5432/test_db';
      expect(() => {
        validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@remote.net:5432/test_db');
      }).toThrow(/without explicit ALLOW_REMOTE_TEST_DB=true/);

      // Reject remote when database-name allowlist is missing
      process.env.ALLOW_REMOTE_TEST_DB = 'true';
      delete process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_NAMES;
      expect(() => {
        validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@remote.net:5432/test_db');
      }).toThrow(/strictly requires a non-empty MIGRATIONGUARD_ALLOWED_TEST_DATABASE_NAMES allowlist/);

      // Reject remote when database name is unapproved
      process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_NAMES = 'other_db';
      expect(() => {
        validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@remote.net:5432/test_db');
      }).toThrow(/Remote database name 'test_db' is not present in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_NAMES allowlist/);

      // Reject remote when ports allowlist is missing (Run 005.13 P1)
      process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_NAMES = 'test_db';
      delete process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS;
      expect(() => {
        validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@remote.net:5432/test_db');
      }).toThrow(/strictly requires a non-empty MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS allowlist/);

      // Reject remote when port is unapproved
      process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS = '5433';
      expect(() => {
        validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@remote.net:5432/test_db');
      }).toThrow(/Remote database port '5432' is not present in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS allowlist/);

      // Reject remote when targets allowlist is missing (Run 005.13 P1)
      process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_PORTS = '5432';
      delete process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS;
      expect(() => {
        validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@remote.net:5432/test_db');
      }).toThrow(/strictly requires a non-empty MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS allowlist/);

      // Reject remote when target tuple is unapproved
      process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS = 'remote.net:5432/other_db';
      expect(() => {
        validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@remote.net:5432/test_db');
      }).toThrow(/Remote database target tuple 'remote.net:5432\/test_db' is not present in MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS allowlist/);

      // Accept when properly configured
      process.env.MIGRATIONGUARD_ALLOWED_TEST_DATABASE_TARGETS = 'remote.net:5432/test_db';
      const target = validateSafeTestDatabaseEndpoint('postgresql://postgres:pass@remote.net:5432/test_db');
      expect(target.host).toBe('remote.net');
      expect(target.port).toBe('5432');
      expect(target.dbName).toBe('test_db');
    });

    it('enforces safe test endpoint validation for MongoDB and Redis test targets', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.ALLOW_REMOTE_TEST_MONGO;
      delete process.env.ALLOW_REMOTE_TEST_REDIS;

      // Reject /prod/i in Mongo and Redis
      expect(() => validateSafeTestMongoEndpoint('mongodb://user:pass@localhost:27017/prod_app')).toThrow(/matches production naming patterns/);
      expect(() => validateSafeTestRedisEndpoint('redis://prod-cache.internal:6379')).toThrow(/matches production naming patterns/);

      // Reject remote Mongo/Redis without explicit allowlist approval
      expect(() => validateSafeTestMongoEndpoint('mongodb+srv://user:pass@cluster0.test.mongodb.net/test_db')).toThrow(/without explicit ALLOW_REMOTE_TEST_MONGO=true/);
      expect(() => validateSafeTestRedisEndpoint('rediss://cache.staging.example.com:6380')).toThrow(/without explicit ALLOW_REMOTE_TEST_REDIS=true/);

      // Reject non-allowlisted remote hosts even when ALLOW_REMOTE_TEST_* is true
      process.env.ALLOW_REMOTE_TEST_MONGO = 'true';
      process.env.MIGRATIONGUARD_ALLOWED_TEST_MONGO_HOSTS = 'approved-mongo.test.net';
      expect(() => validateSafeTestMongoEndpoint('mongodb+srv://user:pass@other.test.net/test_db')).toThrow(/not present in MIGRATIONGUARD_ALLOWED_TEST_MONGO_HOSTS/);

      process.env.ALLOW_REMOTE_TEST_REDIS = 'true';
      process.env.MIGRATIONGUARD_ALLOWED_TEST_REDIS_HOSTS = 'approved-redis.test.net';
      expect(() => validateSafeTestRedisEndpoint('rediss://other-redis.test.net:6380')).toThrow(/not present in MIGRATIONGUARD_ALLOWED_TEST_REDIS_HOSTS/);

      // Accept localhost and allowlisted remote test endpoints
      const localMongo = validateSafeTestMongoEndpoint('mongodb://localhost:27017/migrationguard_e2e_source');
      expect(localMongo.isLoopback).toBe(true);
      const localRedis = validateSafeTestRedisEndpoint('redis://127.0.0.1:6379');
      expect(localRedis.isLoopback).toBe(true);
    });
  });
});
