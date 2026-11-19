import { describe, expect, it } from 'vitest';
import { BatchManifestTracker } from '../src/engine/batch-manifest.js';
import { BatchStatus } from '../src/types.js';

describe('Batch Manifest & State Machine (FR-EXEC-003)', () => {
  it('creates batch in initial PENDING state and transitions through valid lifecycle', async () => {
    const tracker = new BatchManifestTracker();

    const batch = await tracker.createBatch({
      migrationRunId: 'run_m1',
      batchKey: 'batch_001',
      sequenceNo: 1,
      sourceObject: 'customers',
      destinationObject: 'customers',
      sourceCursorStart: null,
    });

    expect(batch.status).toBe('PENDING');
    expect(batch.subStage).toBe('IDLE');
    expect(batch.attemptCount).toBe(0);

    // Transition to QUEUED
    const queued = await tracker.transitionState('run_m1', 'batch_001', 'QUEUED');
    expect(queued.status).toBe('QUEUED');

    // Transition to RUNNING
    const running = await tracker.transitionState('run_m1', 'batch_001', 'RUNNING', 'READ_STARTED');
    expect(running.status).toBe('RUNNING');
    expect(running.subStage).toBe('READ_STARTED');
    expect(running.attemptCount).toBe(1);
    expect(running.startedAt).toBeDefined();

    // Transition to COMMITTED
    const committed = await tracker.transitionState(
      'run_m1',
      'batch_001',
      'COMMITTED',
      'CHECKPOINT_COMMITTED',
    );
    expect(committed.status).toBe('COMMITTED');
    expect(committed.subStage).toBe('CHECKPOINT_COMMITTED');
    expect(committed.completedAt).toBeDefined();
  });

  it('supports all exact required states: PENDING, QUEUED, RUNNING, COMMITTED, RETRY_WAIT, FAILED_RETRYABLE, FAILED_PERMANENT, OUTCOME_UNKNOWN', async () => {
    const tracker = new BatchManifestTracker();

    const states: BatchStatus[] = [
      'PENDING',
      'QUEUED',
      'RUNNING',
      'COMMITTED',
      'RETRY_WAIT',
      'FAILED_RETRYABLE',
      'FAILED_PERMANENT',
      'OUTCOME_UNKNOWN',
    ];

    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      const batchKey = `batch_state_${i}`;

      await tracker.createBatch({
        migrationRunId: 'run_states',
        batchKey,
        sequenceNo: i + 1,
        sourceObject: 'test',
        destinationObject: 'test',
        sourceCursorStart: null,
      });

      if (state !== 'PENDING') {
        if (state === 'QUEUED') {
          await tracker.transitionState('run_states', batchKey, 'QUEUED');
        } else {
          await tracker.transitionState('run_states', batchKey, 'RUNNING');
          if (state !== 'RUNNING') {
            await tracker.transitionState('run_states', batchKey, state);
          }
        }
      }

      const saved = await tracker.getBatch('run_states', batchKey);
      expect(saved?.status).toBe(state);
    }
  });

  it('rejects invalid state transitions', async () => {
    const tracker = new BatchManifestTracker();
    await tracker.createBatch({
      migrationRunId: 'run_invalid',
      batchKey: 'batch_err',
      sequenceNo: 1,
      sourceObject: 'col',
      destinationObject: 'col',
      sourceCursorStart: null,
    });

    // PENDING cannot transition directly to COMMITTED without RUNNING
    await expect(async () => {
      await tracker.transitionState('run_invalid', 'batch_err', 'COMMITTED');
    }).rejects.toThrow(/Invalid batch state transition: cannot transition from PENDING to COMMITTED/);
  });

  it('records and queries record manifests with hashes and outcomes', async () => {
    const tracker = new BatchManifestTracker();

    await tracker.recordManifests([
      {
        migrationRunId: 'run_rec',
        batchKey: 'batch_rec_01',
        sourceObject: 'docs',
        sourceKey: 'doc_1',
        destinationObject: 'docs',
        destinationKey: 'doc_1',
        contentHash: 'a1b2c3d4e5',
        status: 'WRITTEN',
      },
      {
        migrationRunId: 'run_rec',
        batchKey: 'batch_rec_01',
        sourceObject: 'docs',
        sourceKey: 'doc_2',
        destinationObject: 'docs',
        destinationKey: 'doc_2',
        status: 'SKIPPED',
      },
      {
        migrationRunId: 'run_rec',
        batchKey: 'batch_rec_01',
        sourceObject: 'docs',
        sourceKey: 'doc_3',
        destinationObject: 'docs',
        destinationKey: 'doc_3',
        status: 'FAILED',
        error: 'Data truncation',
      },
    ]);

    const manifests = await tracker.listRecordManifests('run_rec', 'batch_rec_01');
    expect(manifests.length).toBe(3);
    expect(manifests[0].status).toBe('WRITTEN');
    expect(manifests[0].contentHash).toBe('a1b2c3d4e5');
    expect(manifests[1].status).toBe('SKIPPED');
    expect(manifests[2].status).toBe('FAILED');
    expect(manifests[2].error).toBe('Data truncation');
  });
});
