import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { ConnectorFactory, PostgresDestinationConnector } from '../src/connectors/connector-factory.js';
import { TransformedBatch } from '../src/types.js';

describe('Real PostgreSQL Destination Connector Integration', () => {
  const dbUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres_password@localhost:5432/migrationguard_control?schema=public';

  if (process.env.NODE_ENV === 'production') {
    throw new Error('[Safety Guard] Live destination write integration tests must never run in production.');
  }

  const isLocalOrCi = (() => {
    try {
      const parsed = new URL(dbUrl);
      const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().trim();
      return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '0.0.0.0' ||
        host.startsWith('127.') ||
        host === '::'
      );
    } catch {
      return dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1') || dbUrl.includes('::1');
    }
  })();

  const isTestDbName = dbUrl.includes('test') || dbUrl.includes('dev');
  const ssl = isLocalOrCi ? false : { rejectUnauthorized: true };

  const testSchema = `test_dest_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const testKey = `test_cust_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  let adminPool: pg.Pool;
  let connectorPool: pg.Pool;
  let connector: PostgresDestinationConnector;

  beforeAll(async () => {
    if (!isLocalOrCi && !isTestDbName && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
      console.warn('[Safety Guard] Refusing to run integration test against non-test/non-local database without ALLOW_REMOTE_TEST_DB=true.');
      return;
    }

    adminPool = new pg.Pool({ connectionString: dbUrl, ssl, max: 2 });
    try {
      await adminPool.query('SELECT 1');
      await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${testSchema}"`);
    } catch (err: any) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] Live PostgreSQL destination unreachable in CI: ${err.message}`);
      }
      console.warn(`[Notice] Live database offline in sandbox: ${err.message}`);
      return;
    }

    // Connector pool connects strictly scoped to the isolated test schema
    connectorPool = new pg.Pool({
      connectionString: dbUrl,
      ssl,
      max: 5,
      options: `-c search_path="${testSchema}"`,
    });
    connector = ConnectorFactory.createPostgresDestination(connectorPool) as PostgresDestinationConnector;

    // Ensure destination table exists inside the isolated test schema
    await connector.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        phone TEXT,
        tier TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        metadata JSONB
      )
    `);
  });

  afterAll(async () => {
    if (connector) {
      await connector.close().catch(() => {});
    }
    // Safely drop ONLY the isolated test schema, never shared application tables
    if (adminPool) {
      try {
        await adminPool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      } catch {}
      await adminPool.end().catch(() => {});
    }
  });

  it('should verify live PostgreSQL connectivity', async () => {
    if (!connector) {
      if (process.env.CI === 'true') {
        throw new Error('[CI Mandatory Failure] Connector was not initialized in CI.');
      }
      console.warn('[Notice] Live database offline in sandbox, skipping test.');
      return;
    }
    const res = await connector.testConnection();
    if (!res.success) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] Live PostgreSQL connection failed in CI: ${res.message}`);
      }
      console.warn(`[Notice] Live database offline in sandbox: ${res.message}`);
      return;
    }
    expect(res.success).toBe(true);
    expect(res.latencyMs).toBeGreaterThan(0);
  });

  it('should write real transformed batch into destination PostgreSQL', async () => {
    if (!connector) return;
    const check = await connector.testConnection();
    if (!check.success) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] Live PostgreSQL destination write failed in CI: ${check.message}`);
      }
      console.warn(`[Notice] Live database offline in sandbox, skipping write`);
      return;
    }

    const batch: TransformedBatch = {
      destinationObject: 'customers',
      batchKey: 'batch_test_real_001',
      records: [
        {
          sourceObject: 'customers',
          sourceKey: testKey,
          destinationObject: 'customers',
          destinationKey: testKey,
          data: {
            id: testKey,
            name: 'Acme Test Corp',
            email: 'acme@testcorp.com',
            phone: '+1-555-0199',
            tier: 'ENTERPRISE',
            created_at: new Date().toISOString(),
            metadata: JSON.stringify({ verified: true, source: 'live_worker_test' }),
          },
          contentHash: 'sha256:test123456789',
        },
      ],
    };

    const writeResult = await connector.writeBatch(batch, {
      writeMode: 'upsert',
      conflictColumns: ['id'],
      updateColumns: ['name', 'email', 'phone', 'tier', 'metadata'],
    });

    expect(writeResult.recordsWritten + writeResult.recordsSkipped).toBeGreaterThanOrEqual(1);
    expect(writeResult.recordsFailed).toBe(0);
  });

  it('should read written records back from destination PostgreSQL using readByKeys', async () => {
    if (!connector) return;
    const check = await connector.testConnection();
    if (!check.success) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] Live PostgreSQL destination read failed in CI: ${check.message}`);
      }
      console.warn(`[Notice] Live database offline in sandbox, skipping read`);
      return;
    }

    const records = await connector.readByKeys('customers', [testKey]);
    expect(records).toHaveLength(1);
    expect(records[0].destinationKey).toBe(testKey);
    expect(records[0].data.name).toBe('Acme Test Corp');
    expect(records[0].data.email).toBe('acme@testcorp.com');

    console.log('[PostgreSQL Destination Write Integration] Verified real write and readByKeys on live PostgreSQL.');
  });
});
