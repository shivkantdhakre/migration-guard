import { describe, expect, it } from 'vitest';
import { BatchManifestTracker } from '../src/engine/batch-manifest.js';
import { CheckpointManager } from '../src/engine/checkpoint.js';
import { IdTracker } from '../src/engine/id-tracker.js';
import { MigrationRunner } from '../src/engine/migration-runner.js';
import { SourceRecordEnvelope } from '../src/types.js';
import { MockDestinationConnector, MockSourceConnector } from './helpers/mock-connectors.js';

describe('Checkpoint Manager & Recovery Engine (FR-REC-001)', () => {
  it('advances checkpoint monotonically and prevents sequence regressions', async () => {
    const manager = new CheckpointManager();

    const mockBatch = {
      id: 'b1',
      migrationRunId: 'run_cp',
      batchKey: 'batch_01',
      sequenceNo: 1,
      status: 'COMMITTED' as const,
      sourceObject: 'customers',
      destinationObject: 'customers',
      sourceCursorStart: null,
      sourceCursorEnd: { lastId: 'c10' },
      recordsRead: 10,
      recordsWritten: 10,
      recordsSkipped: 0,
      recordsFailed: 0,
      attemptCount: 1,
      maxAttempts: 3,
    };

    const cp1 = await manager.advanceCheckpoint({
      migrationRunId: 'run_cp',
      sourceObject: 'customers',
      batch: mockBatch,
      planVersionId: 'p1',
      mappingVersionId: 'm1',
      recordsCommittedCount: 10,
      cursorEnd: { lastId: 'c10' },
    });

    expect(cp1.lastCommittedSequenceNo).toBe(1);
    expect(cp1.totalRecordsCommitted).toBe(10);
    expect(cp1.lastCommittedCursor?.lastId).toBe('c10');

    // Advance to sequence 2
    const mockBatch2 = { ...mockBatch, sequenceNo: 2, batchKey: 'batch_02' };
    const cp2 = await manager.advanceCheckpoint({
      migrationRunId: 'run_cp',
      sourceObject: 'customers',
      batch: mockBatch2,
      planVersionId: 'p1',
      mappingVersionId: 'm1',
      recordsCommittedCount: 10,
      cursorEnd: { lastId: 'c20' },
    });
    expect(cp2.lastCommittedSequenceNo).toBe(2);
    expect(cp2.totalRecordsCommitted).toBe(20);

    // Attempt to regress sequence to 1 should throw
    await expect(async () => {
      await manager.advanceCheckpoint({
        migrationRunId: 'run_cp',
        sourceObject: 'customers',
        batch: mockBatch, // sequence 1
        planVersionId: 'p1',
        mappingVersionId: 'm1',
        recordsCommittedCount: 10,
        cursorEnd: { lastId: 'c10' },
      });
    }).rejects.toThrow(/Cannot regress checkpoint sequence/);
  });

  it('handles out-of-order concurrent batch completion safely and advances contiguous high-water mark', async () => {
    const manager = new CheckpointManager();

    const batch1 = {
      id: 'b1',
      migrationRunId: 'run_concurrent',
      batchKey: 'batch_customers_0001',
      sequenceNo: 1,
      status: 'COMMITTED' as const,
      sourceObject: 'customers',
      destinationObject: 'customers',
      sourceCursorStart: null,
      sourceCursorEnd: { offset: 100 },
      recordsRead: 100,
      recordsWritten: 100,
      recordsSkipped: 0,
      recordsFailed: 0,
      attemptCount: 1,
      maxAttempts: 3,
    };

    const batch2 = {
      id: 'b2',
      migrationRunId: 'run_concurrent',
      batchKey: 'batch_customers_0002',
      sequenceNo: 2,
      status: 'COMMITTED' as const,
      sourceObject: 'customers',
      destinationObject: 'customers',
      sourceCursorStart: { offset: 100 },
      sourceCursorEnd: { offset: 200 },
      recordsRead: 100,
      recordsWritten: 100,
      recordsSkipped: 0,
      recordsFailed: 0,
      attemptCount: 1,
      maxAttempts: 3,
    };

    // Scenario: Batch 2 commits BEFORE Batch 1
    const cpBatch2First = await manager.advanceCheckpoint({
      migrationRunId: 'run_concurrent',
      sourceObject: 'customers',
      batch: batch2,
      planVersionId: 'p1',
      mappingVersionId: 'm1',
      recordsCommittedCount: 100,
      cursorEnd: { offset: 200 },
    });

    // Batch 2 committed, records written tracked
    expect(cpBatch2First.totalRecordsCommitted).toBe(100);

    // Now Batch 1 finishes and commits - MUST NOT THROW!
    const cpBatch1Second = await manager.advanceCheckpoint({
      migrationRunId: 'run_concurrent',
      sourceObject: 'customers',
      batch: batch1,
      planVersionId: 'p1',
      mappingVersionId: 'm1',
      recordsCommittedCount: 100,
      cursorEnd: { offset: 100 },
    });

    // Checkpoint contiguous high-water mark now advances to 2 and points to batch 2 cursor
    expect(cpBatch1Second.lastCommittedSequenceNo).toBe(2);
    expect(cpBatch1Second.totalRecordsCommitted).toBe(200);
    expect(cpBatch1Second.lastCommittedBatchKey).toBe('batch_customers_0002');
    expect(cpBatch1Second.lastCommittedCursor).toEqual({ offset: 200 });
  });

  it('resumes interrupted migration from last committed checkpoint without duplicating or skipping records', async () => {
    // 100 records, batch size 20 -> 5 batches
    const records: SourceRecordEnvelope[] = Array.from({ length: 100 }, (_, i) => ({
      sourceObject: 'customers',
      sourceKey: `cust_${String(i).padStart(3, '0')}`,
      payload: { name: `Customer ${i}` },
      extractedAt: new Date().toISOString(),
    }));

    const sourceConnector = new MockSourceConnector(records);
    const destinationConnector = new MockDestinationConnector();
    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();
    const idTracker = new IdTracker();

    const runner = new MigrationRunner({
      sourceConnector,
      destinationConnector,
      manifestTracker,
      checkpointManager,
      idTracker,
    });

    // Run first 3 batches then simulate crash/pause by pausing
    const runId = 'run_crash_recovery';
    let batchCount = 0;

    // We can inject a failure after batch 3 in the destination connector
    destinationConnector.failAtCall = 4; // Fail on batch 4 write
    destinationConnector.failError = Object.assign(new Error('Process terminated / crash'), {
      code: '57P01',
    });

    await runner.start({
      migrationRunId: runId,
      sourceObject: 'customers',
      destinationObject: 'customers',
      planVersionId: 'plan_v1',
      mappingVersionId: 'map_v1',
      batchSize: 20,
      writeMode: 'upsert',
    });

    // At crash point, run should be FAILED
    expect(runner.getStatus(runId)).toBe('FAILED');

    // First 3 batches (60 records) should be durably committed
    const checkpointBeforeResume = await checkpointManager.getCheckpoint(runId, 'customers');
    expect(checkpointBeforeResume?.lastCommittedSequenceNo).toBe(3);
    expect(checkpointBeforeResume?.totalRecordsCommitted).toBe(60);
    expect(destinationConnector.store.size).toBe(60);

    // Clear connector failure to simulate worker reboot
    destinationConnector.failAtCall = undefined;
    destinationConnector.failError = undefined;

    // Now resume the interrupted migration
    await runner.resume(runId);

    // Migration should complete successfully
    expect(runner.getStatus(runId)).toBe('COMPLETED');

    // All 100 records must be present in destination without any duplicates or omissions
    expect(destinationConnector.store.size).toBe(100);

    const finalCheckpoint = await checkpointManager.getCheckpoint(runId, 'customers');
    expect(finalCheckpoint?.lastCommittedSequenceNo).toBe(5);
    expect(finalCheckpoint?.totalRecordsCommitted).toBe(100);

    // Verify all batches 1..5 are COMMITTED
    const batches = await manifestTracker.listBatches(runId);
    expect(batches.length).toBe(5);
    expect(batches.every((b) => b.status === 'COMMITTED')).toBe(true);
  });
});
