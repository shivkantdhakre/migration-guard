import { describe, expect, it, vi } from 'vitest';
import { BatchManifestTracker, InMemoryBatchManifestStorage } from '../src/engine/batch-manifest.js';
import { PostgresStorageAdapters } from '../src/engine/postgres-storage-adapters.js';
import { BatchStatus, RecordManifest } from '../src/types.js';

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

  it('guarantees idempotency on duplicate writes and supports retry status updates', async () => {
    const storage = new InMemoryBatchManifestStorage();
    const tracker = new BatchManifestTracker(storage);

    // Initial write: record failed
    await tracker.recordManifests([
      {
        migrationRunId: 'run_idem',
        batchKey: 'batch_01',
        sourceObject: 'customers',
        sourceKey: 'cust_101',
        destinationObject: 'customers_dest',
        destinationKey: 'cust_101',
        contentHash: 'hash_v1',
        status: 'FAILED',
        error: 'Network glitch',
      },
    ]);

    let manifests = await tracker.listRecordManifests('run_idem', 'batch_01');
    expect(manifests.length).toBe(1);
    expect(manifests[0].status).toBe('FAILED');
    expect(manifests[0].error).toBe('Network glitch');

    // Retry write: same record identity (migrationRunId, sourceObject, sourceKey) now succeeds
    await tracker.recordManifests([
      {
        migrationRunId: 'run_idem',
        batchKey: 'batch_01',
        sourceObject: 'customers',
        sourceKey: 'cust_101',
        destinationObject: 'customers_dest',
        destinationKey: 'cust_101',
        contentHash: 'hash_v2',
        status: 'WRITTEN',
      },
    ]);

    manifests = await tracker.listRecordManifests('run_idem', 'batch_01');
    // Must update the existing manifest rather than creating a duplicate
    expect(manifests.length).toBe(1);
    expect(manifests[0].status).toBe('WRITTEN');
    expect(manifests[0].contentHash).toBe('hash_v2');
  });

  it('correctly filters record manifests by batchKey and returns all records across batches when omitted', async () => {
    const tracker = new BatchManifestTracker();

    await tracker.recordManifests([
      {
        migrationRunId: 'run_filter',
        batchKey: 'batch_A',
        sourceObject: 'users',
        sourceKey: 'u1',
        destinationObject: 'users',
        destinationKey: 'u1',
        status: 'WRITTEN',
      },
      {
        migrationRunId: 'run_filter',
        batchKey: 'batch_B',
        sourceObject: 'users',
        sourceKey: 'u2',
        destinationObject: 'users',
        destinationKey: 'u2',
        status: 'WRITTEN',
      },
    ]);

    const batchAOnly = await tracker.listRecordManifests('run_filter', 'batch_A');
    expect(batchAOnly.length).toBe(1);
    expect(batchAOnly[0].sourceKey).toBe('u1');

    const allBatches = await tracker.listRecordManifests('run_filter');
    expect(allBatches.length).toBe(2);
  });

  it('PostgresStorageAdapters commits record manifests transactionally with ON CONFLICT and rolls back on failure', async () => {
    const executedQueries: Array<{ text: string; params?: any[] }> = [];
    let isReleased = false;

    const mockClient = {
      query: vi.fn(async (text: string, params?: any[]) => {
        executedQueries.push({ text: text.trim(), params });
        if (text.includes('FAIL_ME') || params?.includes('FAIL_ME')) {
          throw new Error('Simulated database deadlock during manifest insert');
        }
        return { rows: [] };
      }),
      release: vi.fn(() => {
        isReleased = true;
      }),
    };

    const mockPool: any = {
      connect: vi.fn(async () => mockClient),
      query: vi.fn(),
    };

    const adapter = new PostgresStorageAdapters(mockPool);

    // 1. Successful transactional save
    await adapter.saveRecordManifests([
      {
        id: 'man_1',
        migrationRunId: 'run_tx',
        batchKey: 'batch_tx_1',
        sourceObject: 'customers',
        sourceKey: 'c1',
        destinationObject: 'customers_dest',
        destinationKey: 'c1',
        contentHash: 'hash_c1',
        status: 'WRITTEN',
        createdAt: new Date().toISOString(),
      },
    ]);

    expect(executedQueries[0].text).toBe('BEGIN');
    expect(executedQueries[1].text).toContain('ON CONFLICT (migration_run_id, source_object, source_key) DO UPDATE SET');
    expect(executedQueries[2].text).toBe('COMMIT');
    expect(isReleased).toBe(true);

    // 2. Failed transactional save (triggers ROLLBACK)
    executedQueries.length = 0;
    isReleased = false;

    await expect(
      adapter.saveRecordManifests([
        {
          id: 'man_fail',
          migrationRunId: 'run_tx',
          batchKey: 'batch_tx_fail',
          sourceObject: 'customers',
          sourceKey: 'FAIL_ME',
          destinationObject: 'customers_dest',
          destinationKey: 'FAIL_ME',
          status: 'WRITTEN',
          createdAt: new Date().toISOString(),
        },
      ]),
    ).rejects.toThrow(/Simulated database deadlock/);

    expect(executedQueries[0].text).toBe('BEGIN');
    expect(executedQueries[executedQueries.length - 1].text).toBe('ROLLBACK');
    expect(isReleased).toBe(true);
  });

  it('PostgresStorageAdapters round-trips all manifest fields and removes source-object substitution for destination-object', async () => {
    const mockPool: any = {
      connect: vi.fn(),
      query: vi.fn(async (query: string, params: any[]) => {
        expect(query).toContain('WHERE migration_run_id = $1');
        if (params.length > 1) {
          expect(query).toContain('AND batch_key = $2');
        }
        return {
          rows: [
            {
              id: 'uuid-1',
              migration_run_id: 'run-pg-1',
              batch_key: 'batch-pg-001',
              source_object: 'mongo_customers',
              source_key: 'cust_999',
              destination_object: 'pg_customers_target',
              destination_key: 'cust_999',
              content_hash: 'sha256:abc1234',
              status: 'WRITTEN',
              error_details: null,
              created_at: new Date('2026-11-22T00:00:00Z'),
            },
          ],
        };
      }),
    };

    const adapter = new PostgresStorageAdapters(mockPool);
    const manifests = await adapter.listRecordManifests('run-pg-1', 'batch-pg-001');

    expect(manifests.length).toBe(1);
    expect(manifests[0].batchKey).toBe('batch-pg-001');
    expect(manifests[0].sourceObject).toBe('mongo_customers');
    expect(manifests[0].destinationObject).toBe('pg_customers_target'); // Not substituted by sourceObject!
    expect(manifests[0].destinationKey).toBe('cust_999');
    expect(manifests[0].contentHash).toBe('sha256:abc1234');
    expect(manifests[0].status).toBe('WRITTEN');
  });
});
