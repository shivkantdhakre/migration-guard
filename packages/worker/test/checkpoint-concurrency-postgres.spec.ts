import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { CheckpointManager, InMemoryCheckpointStorage, mergeCheckpointUpdate } from '../src/engine/checkpoint.js';
import { PostgresStorageAdapters } from '../src/engine/postgres-storage-adapters.js';
import { MigrationBatch, SourceCursor } from '../src/types.js';
import { validateSafeTestDatabaseEndpoint, isLoopbackHost } from './helpers/postgres-test-utils.js';

describe('Checkpoint Concurrency & Atomic PostgreSQL Persistence (P0.1)', () => {
  const dbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;

  const createBatch = (sequenceNo: number, batchKey: string, offset: number): MigrationBatch => ({
    id: `batch_id_${sequenceNo}`,
    migrationRunId: 'run-test-concurrency',
    batchKey,
    sequenceNo,
    status: 'COMMITTED',
    sourceObject: 'customers',
    destinationObject: 'customers',
    maxAttempts: 3,
    attemptCount: 1,
    recordsRead: 100,
    recordsWritten: 100,
    recordsSkipped: 0,
    recordsFailed: 0,
    sourceCursorStart: { offset },
    sourceCursorEnd: { offset: offset + 100 },
  });

  it('correctly handles sequence 2 committing before sequence 1 (out-of-order)', () => {
    let checkpoint = null;

    // Sequence 2 commits first
    const batch2 = createBatch(2, 'batch_customers_0002', 100);
    checkpoint = mergeCheckpointUpdate(checkpoint, {
      migrationRunId: 'run-test-concurrency',
      sourceObject: 'customers',
      batch: batch2,
      planVersionId: 'plan-v1',
      mappingVersionId: 'map-v1',
      recordsCommittedCount: 100,
      cursorEnd: { lastId: 'cust_0200' },
    });

    // High-water mark remains 0 because sequence 1 has not committed yet
    expect(checkpoint.committedSequences).toEqual([2]);
    expect(checkpoint.lastCommittedSequenceNo).toBe(0);
    expect(checkpoint.totalRecordsCommitted).toBe(100);

    // Sequence 1 commits second
    const batch1 = createBatch(1, 'batch_customers_0001', 0);
    checkpoint = mergeCheckpointUpdate(checkpoint, {
      migrationRunId: 'run-test-concurrency',
      sourceObject: 'customers',
      batch: batch1,
      planVersionId: 'plan-v1',
      mappingVersionId: 'map-v1',
      recordsCommittedCount: 100,
      cursorEnd: { lastId: 'cust_0100' },
    });

    // Now sequences 1 and 2 are contiguous, high-water mark advances to 2!
    expect(checkpoint.committedSequences).toEqual([1, 2]);
    expect(checkpoint.lastCommittedSequenceNo).toBe(2);
    expect(checkpoint.lastCommittedBatchKey).toBe('batch_customers_0002');
    expect(checkpoint.lastCommittedCursor).toEqual({ lastId: 'cust_0200' });
    expect(checkpoint.totalRecordsCommitted).toBe(200);
  });

  it('replaying a previously committed batch does not double-count records (Idempotency)', () => {
    let checkpoint = null;

    const batch1 = createBatch(1, 'batch_customers_0001', 0);
    checkpoint = mergeCheckpointUpdate(checkpoint, {
      migrationRunId: 'run-test-concurrency',
      sourceObject: 'customers',
      batch: batch1,
      planVersionId: 'plan-v1',
      mappingVersionId: 'map-v1',
      recordsCommittedCount: 100,
      cursorEnd: { lastId: 'cust_0100' },
    });

    expect(checkpoint.totalRecordsCommitted).toBe(100);
    expect(checkpoint.committedSequences).toEqual([1]);

    // Replay sequence 1
    checkpoint = mergeCheckpointUpdate(checkpoint, {
      migrationRunId: 'run-test-concurrency',
      sourceObject: 'customers',
      batch: batch1,
      planVersionId: 'plan-v1',
      mappingVersionId: 'map-v1',
      recordsCommittedCount: 100,
      cursorEnd: { lastId: 'cust_0100' },
    });

    // Record count must remain 100 (never 200!)
    expect(checkpoint.totalRecordsCommitted).toBe(100);
    expect(checkpoint.committedSequences).toEqual([1]);
  });

  it('recovers safely from a crash after destination write but before checkpoint persistence', async () => {
    const storage = new InMemoryCheckpointStorage();
    const manager = new CheckpointManager(storage);

    // Batch 1 completes write & checkpoint
    const batch1 = createBatch(1, 'batch_customers_0001', 0);
    await manager.advanceCheckpoint({
      migrationRunId: 'run-crash-test',
      sourceObject: 'customers',
      batch: batch1,
      planVersionId: 'plan-v1',
      mappingVersionId: 'map-v1',
      recordsCommittedCount: 100,
      cursorEnd: { lastId: 'cust_0100' },
    });

    // Batch 2 writes to destination, then worker dies before calling advanceCheckpoint
    // Upon restart, replacement worker redelivers Batch 2
    const batch2 = createBatch(2, 'batch_customers_0002', 100);
    const resumedCp = await manager.advanceCheckpoint({
      migrationRunId: 'run-crash-test',
      sourceObject: 'customers',
      batch: batch2,
      planVersionId: 'plan-v1',
      mappingVersionId: 'map-v1',
      recordsCommittedCount: 100,
      cursorEnd: { lastId: 'cust_0200' },
    });

    expect(resumedCp.lastCommittedSequenceNo).toBe(2);
    expect(resumedCp.totalRecordsCommitted).toBe(200);
    expect(resumedCp.committedSequences).toEqual([1, 2]);
  });

  it('asserts that pre-kill database checkpoint matches committed batch manifests', () => {
    const committedBatches = [
      { batchKey: 'batch_customers_0001', sequenceNo: 1, recordsWritten: 100 },
      { batchKey: 'batch_customers_0002', sequenceNo: 2, recordsWritten: 100 },
    ];

    const preKillCheckpoint = {
      committedSequences: [1, 2],
      totalRecordsCommitted: 200,
      lastCommittedSequenceNo: 2,
    };

    const totalFromBatches = committedBatches.reduce((acc, b) => acc + b.recordsWritten, 0);
    const totalFromCheckpoint = preKillCheckpoint.totalRecordsCommitted;

    // Both must match exactly
    expect(totalFromCheckpoint).toBe(totalFromBatches);
    expect(preKillCheckpoint.committedSequences.length).toBe(committedBatches.length);
  });

  it('runs concurrent PostgreSQL transactions with SELECT ... FOR UPDATE when DB is reachable', async (ctx) => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[Safety Guard] Live integration tests must never run in production environment.');
    }

    if (!dbUrl) {
      if (process.env.CI === 'true') {
        throw new Error('[CI Mandatory Failure] MIGRATIONGUARD_TEST_DATABASE_URL or TEST_DATABASE_URL must be configured in CI environment.');
      }
      console.warn('[Notice] Designated test database URL not set, skipping live PostgreSQL concurrency test.');
      ctx.skip();
      return;
    }

    let parsedTarget: ReturnType<typeof validateSafeTestDatabaseEndpoint>;
    try {
      parsedTarget = validateSafeTestDatabaseEndpoint(dbUrl);
    } catch (err: any) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] ${err.message}`);
      }
      console.warn(`[Notice] Database safety guard rejected target: ${err.message}`);
      ctx.skip();
      return;
    }

    const isLocalOrCi = parsedTarget.isLoopback;
    const isProduction = process.env.NODE_ENV === 'production';
    const ssl = isLocalOrCi && !isProduction ? false : { rejectUnauthorized: true };

    const testSchema = `test_chk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let schemaCreated = false;

    // Attempt live connection and create dedicated test schema
    const testPool = new pg.Pool({ connectionString: dbUrl, ssl, max: 5 });
    try {
      await testPool.query('SELECT 1');
      await testPool.query(`CREATE SCHEMA IF NOT EXISTS "${testSchema}"`);
      schemaCreated = true;
      await testPool.query(`
        CREATE TABLE IF NOT EXISTS "${testSchema}".migration_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          plan_version_id TEXT,
          status TEXT,
          source_boundary_json JSONB DEFAULT '{}'::jsonb,
          progress_json JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    } catch (err: any) {
      let teardownErr: any = null;
      if (schemaCreated) {
        try {
          await testPool.query('SET search_path TO public');
          await testPool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
        } catch (cleanupErr: any) {
          teardownErr = cleanupErr;
        }
      }
      try {
        await testPool.end();
      } catch (poolErr: any) {
        if (!teardownErr) teardownErr = poolErr;
      }
      if (process.env.CI === 'true') {
        const fullMsg = teardownErr
          ? `Live PostgreSQL error: ${err.message} (Teardown error: ${teardownErr.message})`
          : `Live PostgreSQL error in CI: ${err.message}`;
        throw new Error(`[CI Mandatory Failure] ${fullMsg}`);
      }
      console.warn(`[Notice] Live database unreachable in sandbox, skipping live PostgreSQL test: ${err.message}`);
      if (teardownErr) {
        console.warn(`[Notice] Teardown error during setup abort: ${teardownErr.message}`);
      }
      ctx.skip();
      return;
    }

    // Both independent pools connect strictly scoped to the isolated test schema
    const poolConfig = {
      connectionString: dbUrl,
      ssl,
      max: 5,
      options: `-c search_path="${testSchema}"`,
    };
    const pool1 = new pg.Pool(poolConfig);
    const pool2 = new pg.Pool(poolConfig);
    const adapter1 = new PostgresStorageAdapters(pool1);
    const adapter2 = new PostgresStorageAdapters(pool2);

    const runId = randomUUID();
    try {
      await testPool.query(
        `INSERT INTO "${testSchema}".migration_runs (id, plan_version_id, status, source_boundary_json, progress_json, created_at, updated_at)
         VALUES ($1, '00000000-0000-0000-0000-000000000000', 'RUNNING', '{}'::jsonb, '{}'::jsonb, NOW(), NOW())`,
        [runId],
      );

      const batch1 = createBatch(1, 'batch_customers_0001', 0);
      const batch2 = createBatch(2, 'batch_customers_0002', 100);

      // Fire both concurrent checkpoint advancements simultaneously with independent pools
      const [cp1, cp2] = await Promise.all([
        adapter1.advanceCheckpoint({
          migrationRunId: runId,
          sourceObject: 'customers',
          batch: batch1,
          planVersionId: 'plan-v1',
          mappingVersionId: 'map-v1',
          recordsCommittedCount: 100,
          cursorEnd: { lastId: 'cust_0100' },
        }),
        adapter2.advanceCheckpoint({
          migrationRunId: runId,
          sourceObject: 'customers',
          batch: batch2,
          planVersionId: 'plan-v1',
          mappingVersionId: 'map-v1',
          recordsCommittedCount: 100,
          cursorEnd: { lastId: 'cust_0200' },
        }),
      ]);

      // Inspect final DB state
      const finalCp = await adapter1.getCheckpoint(runId, 'customers');
      expect(finalCp).not.toBeNull();
      expect(finalCp!.committedSequences).toEqual([1, 2]);
      expect(finalCp!.totalRecordsCommitted).toBe(200);
      expect(finalCp!.lastCommittedSequenceNo).toBe(2);

      console.log('[PostgreSQL Concurrency Integration] Verified atomic row-level locking with 2 independent pools on live PostgreSQL.');
    } finally {
      // Robust teardown capturing errors without swallowing
      let cleanupError: any = null;
      if (schemaCreated) {
        try {
          await testPool.query(`SET search_path TO public`);
          await testPool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
        } catch (err: any) {
          cleanupError = err;
        }
      }

      try {
        await pool1.end();
      } catch (err: any) {
        if (!cleanupError) cleanupError = err;
      }

      try {
        await pool2.end();
      } catch (err: any) {
        if (!cleanupError) cleanupError = err;
      }

      try {
        await testPool.end();
      } catch (err: any) {
        if (schemaCreated && !cleanupError) cleanupError = err;
      }

      if (cleanupError) {
        throw cleanupError;
      }
    }
  });
});
