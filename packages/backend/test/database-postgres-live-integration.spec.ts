import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseService } from '../src/database/database.service';

describe('Backend PostgreSQL Live Persistence Integration (Run 005.2)', () => {
  let dbService: DatabaseService;
  const isCi = process.env.CI === 'true';
  const testWorkspaceId = `ws-live-test-${Date.now()}`;
  const testSlug = `test-ws-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const testName = `Integration Test Workspace ${Date.now()}`;

  beforeAll(async () => {
    // Explicitly enforce that in-memory fallback is disabled for this test suite
    process.env.ALLOW_IN_MEMORY_DB = 'false';
    process.env.FORCE_POSTGRES_DB = 'true';

    dbService = new DatabaseService();
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
