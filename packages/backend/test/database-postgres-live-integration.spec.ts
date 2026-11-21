import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseService } from '../src/database/database.service';

describe('Backend PostgreSQL Live Persistence Integration (Run 005.2 & Run 005.5)', () => {
  let dbService: DatabaseService;
  const isCi = process.env.CI === 'true';
  const testWorkspaceId = `ws-live-test-${Date.now()}`;
  const testSlug = `test-ws-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const testName = `Integration Test Workspace ${Date.now()}`;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('[Safety Guard] Live backend PostgreSQL integration tests must never run in production environment.');
  }

  // Remote databases MUST be explicitly configured through MIGRATIONGUARD_TEST_DATABASE_URL or TEST_DATABASE_URL.
  // We NEVER approve a remote database simply from DATABASE_URL, even if it contains "test" or "dev".
  const explicitTestDbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;

  const isLocalDatabaseUrl = (() => {
    if (!process.env.DATABASE_URL) return false;
    try {
      const parsed = new URL(process.env.DATABASE_URL);
      return DatabaseService.isLoopbackHost(parsed.hostname);
    } catch {
      return (
        process.env.DATABASE_URL.includes('localhost') ||
        process.env.DATABASE_URL.includes('127.0.0.1') ||
        process.env.DATABASE_URL.includes('::1')
      );
    }
  })();

  const targetDbUrl = explicitTestDbUrl || (isLocalDatabaseUrl ? process.env.DATABASE_URL : undefined);

  const isTargetLocal = (() => {
    if (!targetDbUrl) return false;
    try {
      const parsed = new URL(targetDbUrl);
      return DatabaseService.isLoopbackHost(parsed.hostname);
    } catch {
      return false;
    }
  })();

  beforeAll(async () => {
    if (isCi && !explicitTestDbUrl) {
      throw new Error(
        '[CI Mandatory Failure] MIGRATIONGUARD_TEST_DATABASE_URL or TEST_DATABASE_URL must be explicitly configured in CI environment.',
      );
    }

    if (!targetDbUrl) {
      if (isCi) {
        throw new Error(
          '[CI Mandatory Failure] No valid test database URL configured. Remote DATABASE_URL cannot be used for tests.',
        );
      }
      console.warn(
        '[Safety Guard] Refusing to run tests against remote DATABASE_URL. MIGRATIONGUARD_TEST_DATABASE_URL required.',
      );
      return;
    }

    // If target is remote, require explicit ALLOW_REMOTE_TEST_DB=true override
    if (!isTargetLocal && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
      const msg =
        '[Safety Guard] Refusing to run live persistence test against remote database without explicit ALLOW_REMOTE_TEST_DB=true.';
      if (isCi) {
        throw new Error(`[CI Mandatory Failure] ${msg}`);
      }
      console.warn(msg);
      return;
    }

    // Explicitly enforce that in-memory fallback is disabled for this test suite
    process.env.ALLOW_IN_MEMORY_DB = 'false';
    process.env.FORCE_POSTGRES_DB = 'true';

    dbService = new DatabaseService(targetDbUrl);
    try {
      await dbService.onModuleInit();
    } catch (err: any) {
      if (isCi) {
        throw new Error(`[CI Mandatory Failure] DatabaseService failed to connect to live PostgreSQL: ${err.message}`);
      }
      console.warn(`[Notice] Live database offline in local environment: ${err.message}`);
    }
  });

  afterAll(async () => {
    if (dbService?.isDbConnected) {
      try {
        await dbService.query(`DELETE FROM workspaces WHERE slug = $1`, [testSlug]);
      } catch {}
      await dbService.onModuleDestroy();
    }
    // Restore default for subsequent tests if any
    process.env.ALLOW_IN_MEMORY_DB = 'true';
    delete process.env.FORCE_POSTGRES_DB;
  });

  it('connects to real PostgreSQL without in-memory fallback', async () => {
    if (!dbService?.isDbConnected) {
      if (isCi) {
        throw new Error('[CI Mandatory Failure] Expected DatabaseService to be connected to live PostgreSQL in CI.');
      }
      console.warn('[Notice] Skipping PostgreSQL live persistence test (DB offline).');
      return;
    }

    expect(dbService.isDbConnected).toBe(true);
    const isAlive = await dbService.ping();
    expect(isAlive).toBe(true);
  });

  it('performs live schema migrations and table verification', async () => {
    if (!dbService?.isDbConnected) return;

    // Verify critical tables exist in PostgreSQL
    const res = await dbService.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('workspaces', 'users', 'migration_runs', 'connections')`,
    );
    const tableNames = res.rows.map((r: any) => r.table_name);
    expect(tableNames).toContain('workspaces');
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('migration_runs');
    expect(tableNames).toContain('connections');
  });

  it('executes real transactional persistence and rollback on PostgreSQL', async () => {
    if (!dbService?.isDbConnected) return;

    // 1. Transactional Insert
    await dbService.transaction(async (client) => {
      await client.query(
        `INSERT INTO workspaces (name, slug, status) VALUES ($1, $2, 'ACTIVE')`,
        [testName, testSlug],
      );
    });

    // 2. Query persisted record
    const selectRes = await dbService.query(
      `SELECT id, name, slug FROM workspaces WHERE slug = $1`,
      [testSlug],
    );
    expect(selectRes.rows).toHaveLength(1);
    expect(selectRes.rows[0].name).toBe(testName);
    const workspaceId = selectRes.rows[0].id;

    // 3. Verify Rollback semantics
    let rollbackThrew = false;
    try {
      await dbService.transaction(async (client) => {
        await client.query(
          `UPDATE workspaces SET name = 'Should Not Persist' WHERE id = $1`,
          [workspaceId],
        );
        throw new Error('Simulated failure triggering rollback');
      });
    } catch {
      rollbackThrew = true;
    }
    expect(rollbackThrew).toBe(true);

    // Verify record was rolled back to original name
    const verifyRes = await dbService.query(
      `SELECT name FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    expect(verifyRes.rows[0].name).toBe(testName);

    console.log(
      '[Backend PostgreSQL Live Integration] Verified real database persistence and schema operations on live PostgreSQL.',
    );
  });
});
