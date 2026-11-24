import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { validateSafeTestDatabaseEndpoint } from './redis-test-utils';

describe('Backend PostgreSQL Live Persistence Integration (Run 005.2 & Run 005.5)', () => {
  let dbService: DatabaseService;
  const isCi = process.env.CI === 'true';
  const initialEnv = { ...process.env };
  const testSlug = `test-ws-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const testName = `Integration Test Workspace ${Date.now()}`;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('[Safety Guard] Live backend PostgreSQL integration tests must never run in production environment.');
  }

  // Both local and remote test runs MUST be explicitly designated via MIGRATIONGUARD_TEST_DATABASE_URL or TEST_DATABASE_URL.
  // We NEVER fall back to DATABASE_URL under any circumstances to prevent polluting or dropping tables in development databases.
  const targetDbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;

  beforeAll(async () => {
    if (!targetDbUrl) {
      if (isCi) {
        throw new Error(
          '[CI Mandatory Failure] MIGRATIONGUARD_TEST_DATABASE_URL or TEST_DATABASE_URL must be explicitly configured in CI environment.',
        );
      }
      console.warn(
        '[Safety Guard] No designated test database URL provided. MIGRATIONGUARD_TEST_DATABASE_URL or TEST_DATABASE_URL required. Skipping live integration test.',
      );
      return;
    }

    try {
      validateSafeTestDatabaseEndpoint(targetDbUrl);
    } catch (err: any) {
      if (isCi) {
        throw new Error(`[CI Mandatory Failure] ${err.message}`);
      }
      console.warn(err.message);
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
    let cleanupError: any = null;
    try {
      if (dbService?.isDbConnected) {
        await dbService.query(`DELETE FROM workspaces WHERE slug = $1`, [testSlug]);
      }
    } catch (err: any) {
      cleanupError = err;
    } finally {
      if (dbService) {
        try {
          await dbService.onModuleDestroy();
        } catch (err) {
          if (!cleanupError) cleanupError = err;
        }
      }
      // Restore all environment variables to initial snapshot
      for (const key of Object.keys(process.env)) {
        if (!(key in initialEnv)) {
          delete process.env[key];
        }
      }
      for (const [key, value] of Object.entries(initialEnv)) {
        process.env[key] = value;
      }
    }

    if (cleanupError) {
      throw cleanupError;
    }
  });

  it('connects to real PostgreSQL without in-memory fallback', async (ctx) => {
    if (!dbService?.isDbConnected) {
      if (isCi) {
        throw new Error('[CI Mandatory Failure] Expected DatabaseService to be connected to live PostgreSQL in CI.');
      }
      ctx.skip();
      return;
    }

    expect(dbService.isDbConnected).toBe(true);
    const isAlive = await dbService.ping();
    expect(isAlive).toBe(true);
  });

  it('performs live schema migrations and table verification', async (ctx) => {
    if (!dbService?.isDbConnected) {
      ctx.skip();
      return;
    }

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

  it('executes real transactional persistence and rollback on PostgreSQL', async (ctx) => {
    if (!dbService?.isDbConnected) {
      ctx.skip();
      return;
    }

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

  it('prevents retry on custom casts, overloaded functions, custom operators, and untrusted search_path on real PostgreSQL while retrying built-in reads', async (ctx) => {
    if (!dbService?.isDbConnected || !targetDbUrl) {
      if (isCi) {
        throw new Error('[CI Mandatory Failure] Live PostgreSQL required for semantic retry integration test.');
      }
      ctx.skip();
      return;
    }

    const pg = await import('pg');
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const hazardSchema = `mg_sem_hazard_${suffix}`;
    const cleanSchema = `mg_sem_clean_${suffix}`;
    const hazardDb = new DatabaseService(targetDbUrl, `"${hazardSchema}"`);
    const cleanDb = new DatabaseService(targetDbUrl, `"${cleanSchema}"`);

    const adminPool = (dbService as any).getRawPool() as import('pg').Pool;
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${hazardSchema}"`);
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${cleanSchema}"`);

    try {
      // 1. Setup hazard schema with real PostgreSQL custom type, custom cast, overloaded LOWER(), and custom '+' operator
      await adminPool.query(`CREATE TABLE "${hazardSchema}".side_effects (event_name text NOT NULL)`);
      await adminPool.query(`CREATE TYPE "${hazardSchema}".custom_secret AS (raw_val text)`);
      await adminPool.query(`
        CREATE FUNCTION "${hazardSchema}".cast_secret_to_text(v "${hazardSchema}".custom_secret)
        RETURNS text AS $$
        BEGIN
          INSERT INTO "${hazardSchema}".side_effects (event_name) VALUES ('custom_cast');
          RETURN v.raw_val;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await adminPool.query(`
        CREATE CAST ("${hazardSchema}".custom_secret AS text)
        WITH FUNCTION "${hazardSchema}".cast_secret_to_text("${hazardSchema}".custom_secret);
      `);
      await adminPool.query(`
        CREATE FUNCTION "${hazardSchema}".lower(v "${hazardSchema}".custom_secret)
        RETURNS text AS $$
        BEGIN
          INSERT INTO "${hazardSchema}".side_effects (event_name) VALUES ('custom_lower_overload');
          RETURN pg_catalog.lower(v.raw_val);
        END;
        $$ LANGUAGE plpgsql;
      `);
      await adminPool.query(`
        CREATE FUNCTION "${hazardSchema}".add_secret(a "${hazardSchema}".custom_secret, b "${hazardSchema}".custom_secret)
        RETURNS text AS $$
        BEGIN
          INSERT INTO "${hazardSchema}".side_effects (event_name) VALUES ('custom_plus_op');
          RETURN a.raw_val || '+' || b.raw_val;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await adminPool.query(`
        CREATE OPERATOR "${hazardSchema}".+ (
          LEFTARG = "${hazardSchema}".custom_secret,
          RIGHTARG = "${hazardSchema}".custom_secret,
          FUNCTION = "${hazardSchema}".add_secret
        );
      `);
      await adminPool.query(`
        CREATE TABLE "${hazardSchema}".records (
          id integer NOT NULL,
          custom_value "${hazardSchema}".custom_secret NOT NULL,
          left_value "${hazardSchema}".custom_secret NOT NULL,
          right_value "${hazardSchema}".custom_secret NOT NULL
        );
      `);
      await adminPool.query(`
        INSERT INTO "${hazardSchema}".records VALUES (
          1,
          ROW('SecVal')::"${hazardSchema}".custom_secret,
          ROW('LeftVal')::"${hazardSchema}".custom_secret,
          ROW('RightVal')::"${hazardSchema}".custom_secret
        );
      `);

      // Also define clean schema with strictly pg_catalog scalar types and no custom objects
      await adminPool.query(`
        CREATE TABLE "${cleanSchema}".safe_records (
          id integer PRIMARY KEY,
          name text NOT NULL,
          left_num integer NOT NULL,
          right_num integer NOT NULL
        );
      `);
      await adminPool.query(
        `INSERT INTO "${cleanSchema}".safe_records (id, name, left_num, right_num) VALUES (1, 'Alice', 10, 32)`,
      );

      // Connect pools scoped to test schemas (avoiding runMigrations via manual connected pool wiring)
      const hazardPool = new pg.Pool({
        connectionString: targetDbUrl,
        options: `-c search_path="${hazardSchema}"`,
      });
      const cleanPool = new pg.Pool({
        connectionString: targetDbUrl,
        options: `-c search_path="${cleanSchema}"`,
      });

      const wrapPoolWithTransientDropOnAttempt1 = (
        realPool: import('pg').Pool,
        matchSql: (sql: string) => boolean,
      ) => {
        let attempts = 0;
        const originalQuery = realPool.query.bind(realPool);
        (realPool as any).query = async (sql: string, params?: any[]) => {
          if (typeof sql === 'string' && matchSql(sql)) {
            attempts++;
            await originalQuery(sql, params); // Execute once on real PG to prove side effects would run on retry
            if (attempts === 1) {
              const err: any = new Error('read ECONNRESET');
              err.code = 'ECONNRESET';
              throw err;
            }
          }
          return originalQuery(sql, params);
        };
        return {
          getAttempts: () => attempts,
          restore: () => {
            (realPool as any).query = originalQuery;
          },
        };
      };

      (hazardDb as any).pool = hazardPool;
      (hazardDb as any).isConnected = true;
      (cleanDb as any).pool = cleanPool;
      (cleanDb as any).isConnected = true;
      await DatabaseService.initSqlParser();

      try {
        // Case 1: custom_value::text (custom source type -> built-in text cast)
        const tracker1 = wrapPoolWithTransientDropOnAttempt1(hazardPool, (s) => s.includes('custom_value::text'));
        await expect(
          hazardDb.query(`SELECT custom_value::text FROM "${hazardSchema}".records`),
        ).rejects.toThrow(/ECONNRESET/);
        expect(tracker1.getAttempts()).toBe(1);
        tracker1.restore();

        // Case 2: LOWER(custom_value) (overloaded user-defined LOWER function)
        const tracker2 = wrapPoolWithTransientDropOnAttempt1(hazardPool, (s) => s.includes('LOWER(custom_value)'));
        await expect(
          hazardDb.query(`SELECT LOWER(custom_value) FROM "${hazardSchema}".records`),
        ).rejects.toThrow(/ECONNRESET/);
        expect(tracker2.getAttempts()).toBe(1);
        tracker2.restore();

        // Case 3: left_value + right_value (custom '+' operator)
        const tracker3 = wrapPoolWithTransientDropOnAttempt1(hazardPool, (s) => s.includes('left_value + right_value'));
        await expect(
          hazardDb.query(`SELECT left_value + right_value FROM "${hazardSchema}".records`),
        ).rejects.toThrow(/ECONNRESET/);
        expect(tracker3.getAttempts()).toBe(1);
        tracker3.restore();

        // Verify each side-effect function ran at most once (zero retries re-invoked side effects)
        const seRes = await adminPool.query(
          `SELECT event_name, COUNT(*)::int AS cnt FROM "${hazardSchema}".side_effects GROUP BY event_name`,
        );
        const counts = Object.fromEntries(seRes.rows.map((r: any) => [r.event_name, r.cnt]));
        expect(counts.custom_cast).toBe(1);
        expect(counts.custom_lower_overload).toBe(1);
        expect(counts.custom_plus_op).toBe(1);

        // Case 4: Safe built-in query in clean schema DOES retry once on ECONNRESET and succeeds
        const safeTracker = wrapPoolWithTransientDropOnAttempt1(cleanPool, (s) => s.includes('LOWER(name)'));
        const okRes = await cleanDb.query(
          `SELECT id, LOWER(name) AS lname, left_num + right_num AS total FROM "${cleanSchema}".safe_records WHERE id = $1`,
          [1],
        );
        expect(safeTracker.getAttempts()).toBe(2);
        expect(okRes.rows[0]).toEqual({ id: 1, lname: 'alice', total: 42 });
        safeTracker.restore();

        // Case 5: Untrusted search_path putting hazardSchema ahead of pg_catalog fails semantic verification
        const untrustedPool = new pg.Pool({
          connectionString: targetDbUrl,
          options: `-c search_path="${hazardSchema}",pg_catalog`,
        });
        try {
          const semUntrusted = await DatabaseService.verifyQuerySemanticRetrySafety(
            untrustedPool,
            `SELECT id, LOWER(name) FROM "${cleanSchema}".safe_records WHERE id = $1`,
          );
          expect(semUntrusted.safe).toBe(false);
          expect(semUntrusted.reason).toMatch(/search_path/i);
        } finally {
          await untrustedPool.end();
        }
      } finally {
        await hazardPool.end().catch(() => {});
        await cleanPool.end().catch(() => {});
      }
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${hazardSchema}" CASCADE`).catch(() => {});
      await adminPool.query(`DROP SCHEMA IF EXISTS "${cleanSchema}" CASCADE`).catch(() => {});
    }
  });
});
