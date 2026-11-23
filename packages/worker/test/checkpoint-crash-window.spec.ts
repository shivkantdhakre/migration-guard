import { describe, it, expect, beforeEach } from 'vitest';
import { RecoveryEngine } from '../src/engine/recovery-engine.js';
import { BatchManifestTracker } from '../src/engine/batch-manifest.js';
import { CheckpointManager } from '../src/engine/checkpoint.js';
import { IdTracker } from '../src/engine/id-tracker.js';
import { MockDestinationConnector } from './helpers/mock-connectors.js';
import { MigrationBatch } from '@migrationguard/core';
import { calculateCanonicalHash } from '@migrationguard/core';

describe('Checkpoint Recovery & Crash Window Remediation Suite', () => {
  let manifestTracker: BatchManifestTracker;
  let checkpointManager: CheckpointManager;
  let idTracker: IdTracker;
  let destConnector: MockDestinationConnector;
  let recoveryEngine: RecoveryEngine;

  const migrationRunId = 'run_crash_test_001';
  const sourceObject = 'customers';
  const destinationObject = 'customers';

  beforeEach(() => {
    manifestTracker = new BatchManifestTracker();
    checkpointManager = new CheckpointManager();
    idTracker = new IdTracker();
    destConnector = new MockDestinationConnector();

    recoveryEngine = new RecoveryEngine({
      destinationConnector: destConnector,
      manifestTracker,
      checkpointManager,
      idTracker,
    });
  });

  // =========================================================================
  // 1. Crash Window: Batch COMMITTED but Checkpoint Not Advanced
  // =========================================================================
  it('reconciles and advances checkpoint when batch was marked COMMITTED but process crashed before advancing checkpoint', async () => {
    // Initial checkpoint at sequence 0
    await checkpointManager.saveCheckpoint({
      migrationRunId,
      sourceObject,
      lastCommittedSequenceNo: 0,
      lastCommittedBatchKey: null,
      lastCommittedCursor: null,
      totalRecordsCommitted: 0,
      updatedAt: new Date().toISOString(),
    });

    // Simulate crash where batch 1 was successfully COMMITTED, but process died before advanceCheckpoint was called
    await manifestTracker.createBatch({
      migrationRunId,
      batchKey: 'batch_001',
      sequenceNo: 1,
      sourceObject,
      destinationObject,
      sourceCursorStart: null,
    });
    await manifestTracker.transitionState(migrationRunId, 'batch_001', 'RUNNING');
    await manifestTracker.transitionState(migrationRunId, 'batch_001', 'COMMITTED', 'CHECKPOINT_COMMITTED');
    await manifestTracker.updateCounters(migrationRunId, 'batch_001', {
      recordsRead: 10,
      recordsWritten: 10,
      sourceCursorEnd: { id: 'cust_10' },
    });

    // Call prepareResume upon worker restart
    const resumeState = await recoveryEngine.prepareResume(
      migrationRunId,
      sourceObject,
      destinationObject,
      'id',
    );

    // Checkpoint must be advanced to sequence 1 reflecting the committed batch
    expect(resumeState.lastCommittedSequenceNo).toBe(1);
    expect(resumeState.lastCommittedBatchKey).toBe('batch_001');
    expect(resumeState.totalRecordsCommitted).toBe(10);
    expect(resumeState.startingCursor).toEqual({ id: 'cust_10' });

    // Reconciliation report should document the fix
    const reconciled = resumeState.reconciledBatches.find((b) => b.batchKey === 'batch_001');
    expect(reconciled).toBeDefined();
    expect(reconciled?.actionTaken).toMatch(/reconciled checkpoint to sequence 1/i);
  });

  // =========================================================================
  // 2. Crash Window: Checkpoint Advanced but Batch Not Marked COMMITTED
  // =========================================================================
  it('reconciles and commits batch when destination was written and checkpoint advanced, but process crashed before marking batch COMMITTED', async () => {
    const records = [
      { id: 'c1', name: 'Alice', email: 'alice@example.com' },
      { id: 'c2', name: 'Bob', email: 'bob@example.com' },
    ];

    // Populate destination database with matching records
    for (const r of records) {
      destConnector.store.set(r.id, r);
    }

    // Create record manifests for written records
    await manifestTracker.recordManifests(
      records.map((r) => ({
        migrationRunId,
        batchKey: 'batch_001',
        sourceObject,
        sourceKey: r.id,
        destinationObject,
        destinationKey: r.id,
        contentHash: calculateCanonicalHash(r),
        status: 'WRITTEN' as const,
      })),
    );

    // Simulate batch left in DESTINATION_WRITTEN stage (crashed right before COMMITTED transition)
    await manifestTracker.createBatch({
      migrationRunId,
      batchKey: 'batch_001',
      sequenceNo: 1,
      sourceObject,
      destinationObject,
      sourceCursorStart: null,
    });

    await manifestTracker.transitionState(migrationRunId, 'batch_001', 'RUNNING');
    await manifestTracker.updateSubStage(migrationRunId, 'batch_001', 'DESTINATION_WRITTEN');
    await manifestTracker.updateCounters(migrationRunId, 'batch_001', {
      recordsRead: 2,
      recordsWritten: 2,
      sourceCursorEnd: { id: 'c2' },
    });

    // Prepare resume
    const resumeState = await recoveryEngine.prepareResume(
      migrationRunId,
      sourceObject,
      destinationObject,
      'id',
    );

    // Batch must be reconciled to COMMITTED and checkpoint confirmed at sequence 1
    expect(resumeState.lastCommittedSequenceNo).toBe(1);
    expect(resumeState.totalRecordsCommitted).toBe(2);

    const updatedBatch = await manifestTracker.getBatch(migrationRunId, 'batch_001');
    expect(updatedBatch?.status).toBe('COMMITTED');
    expect(updatedBatch?.subStage).toBe('CHECKPOINT_COMMITTED');
  });

  // =========================================================================
  // 3. Crash Window: Hash Mismatch / Partial Write
  // =========================================================================
  it('resets batch to RETRY_WAIT and does NOT advance checkpoint when content hashes mismatch during crash recovery', async () => {
    const originalRecord = { id: 'c1', name: 'Alice', email: 'alice@example.com' };
    const corruptedRecord = { id: 'c1', name: 'Corrupted Alice', email: 'alice@example.com' };

    // Write corrupted record to destination
    destConnector.store.set('c1', corruptedRecord);

    await manifestTracker.recordManifests([
      {
        migrationRunId,
        batchKey: 'batch_001',
        sourceObject,
        sourceKey: 'c1',
        destinationObject,
        destinationKey: 'c1',
        contentHash: calculateCanonicalHash(originalRecord),
        status: 'WRITTEN',
      },
    ]);

    await manifestTracker.createBatch({
      migrationRunId,
      batchKey: 'batch_001',
      sequenceNo: 1,
      sourceObject,
      destinationObject,
      sourceCursorStart: null,
    });
    await manifestTracker.transitionState(migrationRunId, 'batch_001', 'RUNNING');
    await manifestTracker.updateSubStage(migrationRunId, 'batch_001', 'DESTINATION_WRITTEN');
    await manifestTracker.updateCounters(migrationRunId, 'batch_001', {
      recordsRead: 1,
      recordsWritten: 1,
      sourceCursorEnd: { id: 'c1' },
    });

    const resumeState = await recoveryEngine.prepareResume(
      migrationRunId,
      sourceObject,
      destinationObject,
      'id',
    );

    // Checkpoint must NOT advance
    expect(resumeState.lastCommittedSequenceNo).toBe(0);

    // Batch must be reset to RETRY_WAIT
    const updatedBatch = await manifestTracker.getBatch(migrationRunId, 'batch_001');
    expect(updatedBatch?.status).toBe('RETRY_WAIT');
  });

  // =========================================================================
  // 4. Missing Record Manifests Crash Recovery
  // =========================================================================
  it('resets batch to RETRY_WAIT when durable manifests are missing for a non-empty batch', async () => {
    await manifestTracker.createBatch({
      migrationRunId,
      batchKey: 'batch_001',
      sequenceNo: 1,
      sourceObject,
      destinationObject,
      sourceCursorStart: null,
    });
    await manifestTracker.transitionState(migrationRunId, 'batch_001', 'RUNNING');
    await manifestTracker.updateSubStage(migrationRunId, 'batch_001', 'WRITE_STARTED');
    await manifestTracker.updateCounters(migrationRunId, 'batch_001', {
      recordsRead: 5,
      recordsWritten: 0,
    });

    const resumeState = await recoveryEngine.prepareResume(
      migrationRunId,
      sourceObject,
      destinationObject,
      'id',
    );

    expect(resumeState.lastCommittedSequenceNo).toBe(0);
    const updatedBatch = await manifestTracker.getBatch(migrationRunId, 'batch_001');
    expect(updatedBatch?.status).toBe('RETRY_WAIT');
  });
});
