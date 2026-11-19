import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresConnector, type PostgresDriverAdapter } from '../dist/connectors/postgres/postgres-connector.js';
import { quoteIdent, quoteTableName, buildBatchInsertQuery } from '../dist/connectors/postgres/query-builder.js';
import type { TransformedBatch } from '../src/types/index.js';

describe('PostgreSQL Destination Connector & Query Builder', () => {
  describe('Query Builder & SQL Injection Safety', () => {
    it('should quote identifiers safely and escape embedded quotes', () => {
      assert.equal(quoteIdent('users'), '"users"');
      assert.equal(quoteIdent('my"table'), '"my""table"');
      assert.equal(quoteTableName('public.users'), '"public"."users"');
      assert.equal(quoteTableName('orders'), '"public"."orders"');
    });

    it('should build parameterized INSERT query for INSERT_ONLY mode', () => {
      const records = [
        { id: '1', name: 'Alice', age: 30 },
        { id: '2', name: 'Bob', age: 25 },
      ];
      const query = buildBatchInsertQuery({
        tableName: 'users',
        records,
        mode: 'INSERT_ONLY',
      });

      assert.ok(query.text.includes('INSERT INTO "public"."users"'));
      assert.ok(query.text.includes('VALUES'));
      assert.equal(query.values.length, 6);
      assert.equal(query.values[0], '1');
      assert.equal(query.values[1], 'Alice');
      assert.equal(query.values[2], 30);
    });

    it('should build parameterized UPSERT query with conflict and update columns', () => {
      const records = [{ id: '1', name: 'Alice', balance: 100 }];
      const query = buildBatchInsertQuery({
        tableName: 'accounts',
        records,
        mode: 'UPSERT',
        conflictColumns: ['id'],
        updateColumns: ['name', 'balance'],
      });

      assert.ok(query.text.includes('ON CONFLICT ("id") DO UPDATE SET'));
      assert.ok(query.text.includes('"name" = EXCLUDED."name"'));
      assert.ok(query.text.includes('"balance" = EXCLUDED."balance"'));
    });

    it('should build SKIP_EXISTING query with ON CONFLICT DO NOTHING', () => {
      const records = [{ id: '1', name: 'Alice' }];
      const query = buildBatchInsertQuery({
        tableName: 'users',
        records,
        mode: 'SKIP_EXISTING',
        conflictColumns: ['id'],
      });

      assert.ok(query.text.includes('ON CONFLICT ("id") DO NOTHING'));
    });
  });

  describe('PostgresConnector Operations (Mock Fixtures)', () => {
    function createMockPgDriver(): PostgresDriverAdapter & { executedQueries: Array<{ text: string; values?: unknown[] }> } {
      const executed: Array<{ text: string; values?: unknown[] }> = [];

      return {
        executedQueries: executed,
        query: async (text: string, values?: unknown[]) => {
          executed.push({ text, values });

          // Test connection query
          if (text.includes('version()')) {
            return { rows: [{ version: 'PostgreSQL 16.2' }], rowCount: 1 };
          }

          // Tables query
          if (text.includes('information_schema.tables')) {
            return {
              rows: [{ table_name: 'customers', table_type: 'BASE TABLE' }],
              rowCount: 1,
            };
          }

          // Columns query
          if (text.includes('information_schema.columns')) {
            return {
              rows: [
                { column_name: 'id', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null },
                { column_name: 'name', data_type: 'varchar', udt_name: 'varchar', is_nullable: 'YES', column_default: null },
              ],
              rowCount: 2,
            };
          }

          // Constraints query
          if (text.includes('table_constraints')) {
            return {
              rows: [{ column_name: 'id' }],
              rowCount: 1,
            };
          }

          // Read by keys
          if (text.includes('IN ($1')) {
            return {
              rows: [
                { id: 'c1', name: 'Alice' },
                { id: 'c2', name: 'Bob' },
              ],
              rowCount: 2,
            };
          }

          // Count query
          if (text.includes('COUNT(*)')) {
            return { rows: [{ count: '42' }], rowCount: 1 };
          }

          // Write batch insert/upsert
          return { rows: [], rowCount: values ? Math.floor(values.length / 2) : 1 };
        },
        close: async () => {},
      };
    }

    it('testConnection: should return healthy result with version and capabilities', async () => {
      const driver = createMockPgDriver();
      const connector = new PostgresConnector({
        config: { host: 'localhost', port: 5432, database: 'pgdb' },
        driver,
      });

      const res = await connector.testConnection();
      assert.equal(res.healthy, true);
      assert.equal(res.serverVersion, 'PostgreSQL 16.2');
    });

    it('inspectSchema: should inspect tables, columns, and primary keys', async () => {
      const driver = createMockPgDriver();
      const connector = new PostgresConnector({
        config: { host: 'localhost', port: 5432, database: 'pgdb', schema: 'public' },
        driver,
      });

      const snapshot = await connector.inspectSchema();
      assert.equal(snapshot.engine, 'POSTGRESQL');
      assert.equal(snapshot.objects.length, 1);
      assert.equal(snapshot.objects[0].name, 'customers');

      const idCol = snapshot.objects[0].fields.find((f) => f.name === 'id');
      assert.ok(idCol);
      assert.equal(idCol.isPrimaryKey, true);
      assert.equal(idCol.nullable, false);
    });

    it('writeBatch: should execute parameterized batch write for TransformedBatch', async () => {
      const driver = createMockPgDriver();
      const connector = new PostgresConnector({
        config: { host: 'localhost', port: 5432, database: 'pgdb' },
        driver,
      });

      const batch: TransformedBatch = {
        batchKey: 'b1',
        sequenceNo: 1,
        records: [
          {
            destinationObject: 'customers',
            destinationKey: 'c1',
            sourceObject: 'customers',
            sourceKey: '1',
            payload: { id: 'c1', name: 'Alice' },
            canonicalHash: 'sha256:...',
          },
        ],
      };

      const res = await connector.writeBatch(batch, {
        mode: 'UPSERT',
        conflictColumns: ['id'],
      });

      assert.ok(res.recordsWritten >= 1);
      assert.equal(driver.executedQueries.length, 1);
      assert.ok(driver.executedQueries[0].text.includes('INSERT INTO "public"."customers"'));
      assert.ok(driver.executedQueries[0].text.includes('ON CONFLICT ("id") DO UPDATE SET'));
    });

    it('readByKeys: should execute parameterized query and return matching records', async () => {
      const driver = createMockPgDriver();
      const connector = new PostgresConnector({
        config: { host: 'localhost', port: 5432, database: 'pgdb' },
        driver,
      });

      const results = await connector.readByKeys('customers', [
        { key: 'id', value: 'c1' },
        { key: 'id', value: 'c2' },
        { key: 'id', value: 'c3' }, // not found in mock
      ]);

      assert.equal(results.length, 3);
      assert.equal(results[0].found, true);
      assert.equal(results[0].destinationKey, 'c1');
      assert.equal(results[0].data.name, 'Alice');

      assert.equal(results[1].found, true);
      assert.equal(results[1].destinationKey, 'c2');

      assert.equal(results[2].found, false);
      assert.equal(results[2].destinationKey, 'c3');
    });

    it('count: should return total record count', async () => {
      const driver = createMockPgDriver();
      const connector = new PostgresConnector({
        config: { host: 'localhost', port: 5432, database: 'pgdb' },
        driver,
      });

      const count = await connector.count('customers');
      assert.equal(count, 42);
    });
  });
});
