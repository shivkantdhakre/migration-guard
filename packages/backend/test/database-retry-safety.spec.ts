import { describe, it, expect, vi, beforeAll } from 'vitest';
import { DatabaseService } from '../src/database/database.service';

describe('DatabaseService Retry-Safety SQL AST Classifier & Semantic Policy', () => {
  beforeAll(async () => {
    await DatabaseService.initSqlParser();
  });

  describe('1. Strictly Allows Known-Safe Single SELECT Read Queries', () => {
    it('allows parameterized single-table SELECT statements', () => {
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT * FROM workspaces WHERE id = $1')).toBe(true);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT id, name, email FROM users WHERE status = $1 ORDER BY created_at DESC LIMIT 10;')).toBe(true);
    });

    it('allows allowlisted pure aggregate, date, string, and JSON functions', () => {
      expect(
        DatabaseService.isSafeRetryableReadQuery(
          'SELECT COUNT(*), COALESCE(SUM(records_written), 0), LOWER(email), UPPER(status) FROM migration_batches WHERE migration_run_id = $1',
        ),
      ).toBe(true);
      expect(
        DatabaseService.isSafeRetryableReadQuery(
          "SELECT DATE_TRUNC('day', created_at) AS day, VERSION(), NOW() FROM migration_runs",
        ),
      ).toBe(true);
      expect(
        DatabaseService.isSafeRetryableReadQuery(
          'SELECT CAST(id AS VARCHAR(64)), ROUND(AVG(latency_ms), 2) FROM ai_traces',
        ),
      ).toBe(true);
    });

    it('allows information_schema catalog inspection queries', () => {
      expect(
        DatabaseService.isSafeRetryableReadQuery(
          "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'",
        ),
      ).toBe(true);
    });

    it('allows safe built-in casts (e.g. ::uuid[], ::int, CAST(... AS VARCHAR(64)))', () => {
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT id FROM connections WHERE id = ANY($1::uuid[]) AND workspace_id = $2')).toBe(true);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT COUNT(*)::int AS cnt FROM migration_batches')).toBe(true);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT CAST($1 AS DOUBLE PRECISION), CAST($2 AS CHARACTER VARYING(100))')).toBe(true);
    });

    it('does not falsely block mutating words inside string literals or quoted identifiers', () => {
      expect(
        DatabaseService.isSafeRetryableReadQuery(
          "SELECT * FROM audit_events WHERE action = 'DELETE' AND payload_text = 'INSERT INTO foo'",
        ),
      ).toBe(true);
      expect(
        DatabaseService.isSafeRetryableReadQuery(
          'SELECT "update", "delete" FROM migration_logs WHERE id = $1',
        ),
      ).toBe(true);
    });
  });

  describe('2. Rejects Side-Effecting Functions, DDL/DML, CTEs, EXPLAIN ANALYZE, and Bypass Attempts', () => {
    it('rejects all mutating statements (INSERT, UPDATE, DELETE, DDL)', () => {
      expect(DatabaseService.isSafeRetryableReadQuery('INSERT INTO users (email) VALUES ($1)')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('UPDATE migration_runs SET status = $1 WHERE id = $2')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('DELETE FROM connections WHERE id = $1')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('DROP TABLE customers')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('TRUNCATE TABLE migration_batches')).toBe(false);
    });

    it('rejects EXPLAIN and EXPLAIN ANALYZE variants', () => {
      expect(DatabaseService.isSafeRetryableReadQuery('EXPLAIN SELECT * FROM users')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('EXPLAIN ANALYZE SELECT * FROM users')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('EXPLAIN (ANALYZE, BUFFERS) DELETE FROM users')).toBe(false);
    });

    it('rejects writeable and arbitrary CTEs (WITH ...)', () => {
      expect(
        DatabaseService.isSafeRetryableReadQuery('WITH deleted AS (DELETE FROM users RETURNING id) SELECT * FROM deleted'),
      ).toBe(false);
      expect(
        DatabaseService.isSafeRetryableReadQuery('WITH rows AS (SELECT * FROM users) SELECT * FROM rows'),
      ).toBe(false);
    });

    it('rejects side-effecting PostgreSQL functions such as pg_notify, set_config, nextval, setval, and advisory locks', () => {
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT pg_notify('channel', 'message')")).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT set_config('some.setting', 'value', false)")).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT nextval('users_id_seq')")).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT setval('users_id_seq', 100)")).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT pg_advisory_lock(12345)')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT pg_try_advisory_xact_lock(hashtext('k'))")).toBe(false);
    });

    it('rejects arbitrary custom functions and obfuscated/comment-split call bypass attempts', () => {
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT custom_mutating_func(1, 2)')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT /* stealth */ pg_notify (\'ch\', \'msg\')')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT -- line comment\n set_config('a', 'b', true)")).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT \"pg_notify\"('ch', 'msg')")).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT pg_catalog.set_config('a', 'b', false)")).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT public.my_udf()')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT COUNT(nextval(\'seq\')) FROM t')).toBe(false);
    });

    it('rejects SET, SHOW, multi-statements, SELECT INTO, and FOR UPDATE/SHARE row locks', () => {
      expect(DatabaseService.isSafeRetryableReadQuery('SET search_path TO public')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SHOW statement_timeout')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT 1; DROP TABLE users')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT * INTO backup_users FROM users')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT * FROM migration_runs WHERE id = $1 FOR UPDATE')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT * FROM migration_runs WHERE id = $1 FOR SHARE')).toBe(false);
    });

    it('rejects custom casts and custom operators that could invoke user-defined functions', () => {
      // PostgreSQL custom types & custom casts backed by functions
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT $1::my_custom_type')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT $1::public.my_custom_type')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT $1::"my_custom_type"')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT CAST($1 AS my_custom_type)')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT CAST($1 AS public.my_custom_type)')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT my_custom_type 'payload'")).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT 'migration_batches'::regclass")).toBe(false);

      // Custom / non-allowlisted operators and OPERATOR(schema.op) syntax
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT $1 <-> $2')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT $1 @> $2')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT $1 @@ $2')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT $1 ### $2')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT $1 OPERATOR(public.+) $2')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT $1 =| $2')).toBe(false);
    });

    it('fails closed on malformed, unclosed strings, comments, or dollar-quotes', () => {
      expect(DatabaseService.isSafeRetryableReadQuery("SELECT 'unclosed")).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT /* unclosed comment 1')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT /* outer /* inner */ unclosed 1')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('SELECT $$unclosed dollar quote')).toBe(false);
      expect(DatabaseService.isSafeRetryableReadQuery('')).toBe(false);
    });
  });

  describe('3. DatabaseService.query Live Retry vs Semantic Fail-Closed Behavior', () => {
    it('retries safe SELECT on transient ECONNRESET when pg_catalog passes, while failing fast on pg_notify, INSERT, and semantic hazards', async () => {
      const db = new DatabaseService();
      let selectAttempts = 0;
      let notifyAttempts = 0;
      let insertAttempts = 0;
      let customCastAttempts = 0;

      const mockPool = {
        query: vi.fn(async (sql: string, params: any[] = []) => {
          if (sql.includes('current_schemas')) {
            return {
              rows: [{ search_schemas: ['pg_catalog', 'public'], explicit_schemas: ['public'] }],
              rowCount: 1,
            };
          }
          if (sql.includes('FROM pg_catalog.pg_class')) {
            const relname = params[1];
            return {
              rows: [{ oid: relname === 'records' ? 2001 : 1001, nspname: 'public', relname, relkind: 'r', relrowsecurity: false }],
              rowCount: 1,
            };
          }
          if (sql.includes('FROM pg_catalog.pg_rewrite')) {
            return { rows: [{ cnt: 0 }], rowCount: 1 };
          }
          if (sql.includes('FROM pg_catalog.pg_attribute')) {
            const oid = params[0];
            if (oid === 2001) {
              return {
                rows: [{ attname: 'custom_value', typname: 'custom_secret', typnamespace: 'public', typtype: 'c' }],
                rowCount: 1,
              };
            }
            return {
              rows: [
                { attname: 'id', typname: 'uuid', typnamespace: 'pg_catalog', typtype: 'b' },
                { attname: 'name', typname: 'text', typnamespace: 'pg_catalog', typtype: 'b' },
              ],
              rowCount: 2,
            };
          }
          if (sql.includes('FROM pg_catalog.pg_proc') || sql.includes('FROM pg_catalog.pg_operator') || sql.includes('FROM pg_catalog.pg_cast')) {
            return { rows: [], rowCount: 0 };
          }

          if (sql.startsWith('SELECT * FROM workspaces')) {
            selectAttempts++;
            if (selectAttempts < 2) {
              const err: any = new Error('read ECONNRESET');
              err.code = 'ECONNRESET';
              throw err;
            }
            return { rows: [{ id: 'ws-1' }], rowCount: 1 };
          }
          if (sql.includes('custom_value::text')) {
            customCastAttempts++;
            const err: any = new Error('read ECONNRESET');
            err.code = 'ECONNRESET';
            throw err;
          }
          if (sql.includes('pg_notify')) {
            notifyAttempts++;
            const err: any = new Error('read ECONNRESET');
            err.code = 'ECONNRESET';
            throw err;
          }
          if (sql.startsWith('INSERT')) {
            insertAttempts++;
            const err: any = new Error('Connection terminated unexpectedly');
            throw err;
          }
          return { rows: [], rowCount: 0 };
        }),
      };

      (db as any).pool = mockPool;
      (db as any).isConnected = true;

      // Safe SELECT retries once and succeeds after catalog verification passes
      const selectRes = await db.query('SELECT * FROM workspaces WHERE id = $1', ['ws-1']);
      expect(selectRes.rows).toEqual([{ id: 'ws-1' }]);
      expect(selectAttempts).toBe(2);

      // Lexical-passing custom source cast query fails semantic catalog check and NEVER retries
      await expect(db.query('SELECT custom_value::text FROM records')).rejects.toThrow(/ECONNRESET/);
      expect(customCastAttempts).toBe(1);

      // Side-effecting pg_notify NEVER retries (fails after 1 attempt)
      await expect(db.query("SELECT pg_notify('ch', 'msg')")).rejects.toThrow(/ECONNRESET/);
      expect(notifyAttempts).toBe(1);

      // Mutating INSERT NEVER retries (fails after 1 attempt)
      await expect(db.query('INSERT INTO users (email) VALUES ($1)', ['a@b.com'])).rejects.toThrow(/Connection terminated/);
      expect(insertAttempts).toBe(1);
    });

    it('fails closed when search_path does not put pg_catalog first', async () => {
      const db = new DatabaseService();
      let attempts = 0;
      (db as any).pool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('current_schemas')) {
            return {
              rows: [{ search_schemas: ['public', 'pg_catalog'], explicit_schemas: ['public'] }],
              rowCount: 1,
            };
          }
          attempts++;
          const err: any = new Error('read ECONNRESET');
          err.code = 'ECONNRESET';
          throw err;
        }),
      };
      (db as any).isConnected = true;

      await expect(db.query('SELECT LOWER(email) FROM users WHERE id = $1', ['u-1'])).rejects.toThrow(/ECONNRESET/);
      expect(attempts).toBe(1);
    });
  });
});
