import { describe, expect, it } from 'vitest';
import { BatchManifestTracker } from '../src/engine/batch-manifest.js';
import { CheckpointManager } from '../src/engine/checkpoint.js';
import { IdTracker } from '../src/engine/id-tracker.js';
import { QueueHandler } from '../src/engine/queue-handler.js';
import { MigrationJobPayload, SourceRecordEnvelope } from '../src/types.js';
import { MockDestinationConnector, MockSourceConnector } from './helpers/mock-connectors.js';

describe('Queue Message Handler (BullMQ / Redis Constraint FR-EXEC-002)', () => {
  it('strictly rejects queue payloads that attempt to transport bulk records', () => {
    // Attempting to send records in payload violates architectural rule
    const illegalPayload = {
      jobId: 'job_001',
      migrationRunId: 'run_123',
      batchKey: 'batch_001',
      sequenceNo: 1,
      sourceObject: 'customers',
      destinationObject: 'customers',
      cursorStart: null,
      batchSize: 100,
      planVersionId: 'plan_v1',
      mappingVersionId: 'map_v1',
      writeMode: 'insert_only',
      records: [{ id: '1', name: 'Alice' }], // ILLEGAL
    };

    expect(() => QueueHandler.validatePayload(illegalPayload)).toThrow(
      /Architectural violation \(FR-EXEC-002\): Queue payloads must NEVER carry bulk records!/,
    );

    const illegalPayload2 = {
      ...illegalPayload,
      records: undefined,
      bulkData: ['row1', 'row2'], // ILLEGAL
    };
    expect(() => QueueHandler.validatePayload(illegalPayload2)).toThrow(
      /Architectural violation \(FR-EXEC-002\)/,
    );
  });

  it('accepts valid lightweight payload containing IDs and cursors only', () => {
    const validPayload: MigrationJobPayload = {
      jobId: 'job_001',
      migrationRunId: 'run_123',
      batchKey: 'batch_001',
      sequenceNo: 1,
      sourceObject: 'customers',
      destinationObject: 'customers',
      cursorStart: { lastId: 'cust_0100' },
      batchSize: 100,
      planVersionId: 'plan_v1',
      mappingVersionId: 'map_v1',
      writeMode: 'upsert',
    };

    expect(() => QueueHandler.validatePayload(validPayload)).not.toThrow();
  });

  it('processes valid payload end-to-end: reads, writes, persists manifest & checkpoint, and schedules next', async () => {
    const mockRecords: SourceRecordEnvelope[] = Array.from({ length: 50 }, (_, i) => ({
      sourceObject: 'customers',
      sourceKey: `cust_${i}`,
      payload: { name: `Customer ${i}`, email: `cust${i}@test.com` },
      extractedAt: new Date().toISOString(),
    }));

    const sourceConnector = new MockSourceConnector(mockRecords);
    const destinationConnector = new MockDestinationConnector();
    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();
    const idTracker = new IdTracker();

    let scheduledNext: MigrationJobPayload | undefined;

    const handler = new QueueHandler({
      sourceConnector,
      destinationConnector,
      manifestTracker,
      checkpointManager,
      idTracker,
      onNextBatchScheduled: (payload) => {
        scheduledNext = payload;
      },
    });

    const payload: MigrationJobPayload = {
      jobId: 'job_run_1_batch_001',
      migrationRunId: 'run_1',
      batchKey: 'batch_customers_seq_000001',
      sequenceNo: 1,
      sourceObject: 'customers',
      destinationObject: 'customers',
      cursorStart: null,
      batchSize: 20,
      planVersionId: 'plan_v1',
      mappingVersionId: 'map_v1',
      writeMode: 'insert_only',
    };

    const result = await handler.processJob(payload);

    expect(result.status).toBe('COMMITTED');
    expect(result.recordsRead).toBe(20);
    expect(result.recordsWritten).toBe(20);
    expect(result.hasMore).toBe(true);

    // Verify destination connector received the records
    expect(destinationConnector.store.size).toBe(20);
    expect(destinationConnector.store.has('cust_0')).toBe(true);

    // Verify manifest persisted in COMMITTED state
    const batch = await manifestTracker.getBatch('run_1', 'batch_customers_seq_000001');
    expect(batch?.status).toBe('COMMITTED');
    expect(batch?.recordsWritten).toBe(20);

    // Verify checkpoint advanced
    const checkpoint = await checkpointManager.getCheckpoint('run_1', 'customers');
    expect(checkpoint?.lastCommittedSequenceNo).toBe(1);
    expect(checkpoint?.totalRecordsCommitted).toBe(20);

    // Verify ID mappings recorded
    const mapped = await idTracker.getDestinationKey('run_1', 'customers', 'cust_0');
    expect(mapped).toBe('cust_0');

    // Verify next payload was scheduled with cursors only
    expect(scheduledNext).toBeDefined();
    expect(scheduledNext?.sequenceNo).toBe(2);
    expect(scheduledNext?.cursorStart?.lastId).toBe('cust_19');
    expect(() => QueueHandler.validatePayload(scheduledNext)).not.toThrow();
  });

  it('transitions to RETRY_WAIT when transient error occurs and attempts remain', async () => {
    const sourceConnector = new MockSourceConnector([
      {
        sourceObject: 'users',
        sourceKey: 'u1',
        payload: { name: 'Bob' },
        extractedAt: new Date().toISOString(),
      },
    ]);
    const destinationConnector = new MockDestinationConnector();
    destinationConnector.failAtCall = 1;
    // Simulate retryable DB deadlock
    destinationConnector.failError = Object.assign(new Error('deadlock detected'), { code: '40P01' });

    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const handler = new QueueHandler({
      sourceConnector,
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    const payload: MigrationJobPayload = {
      jobId: 'job_deadlock_1',
      migrationRunId: 'run_retry',
      batchKey: 'batch_deadlock',
      sequenceNo: 1,
      sourceObject: 'users',
      destinationObject: 'users',
      cursorStart: null,
      batchSize: 10,
      planVersionId: 'plan_v1',
      mappingVersionId: 'map_v1',
      writeMode: 'insert_only',
    };

    const result = await handler.processJob(payload);

    expect(result.status).toBe('RETRY_WAIT');
    const batch = await manifestTracker.getBatch('run_retry', 'batch_deadlock');
    expect(batch?.status).toBe('RETRY_WAIT');
    expect(batch?.errorSummary?.classification).toBe('RETRYABLE');
  });

  it('transitions to FAILED_PERMANENT when non-retryable error occurs', async () => {
    const sourceConnector = new MockSourceConnector([
      {
        sourceObject: 'users',
        sourceKey: 'u1',
        payload: { name: 'Alice' },
        extractedAt: new Date().toISOString(),
      },
    ]);
    const destinationConnector = new MockDestinationConnector();
    destinationConnector.failAtCall = 1;
    // Simulate non-retryable NOT NULL constraint violation
    destinationConnector.failError = Object.assign(
      new Error('null value in column "email" violates not-null constraint'),
      { code: '23502' },
    );

    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const handler = new QueueHandler({
      sourceConnector,
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    const payload: MigrationJobPayload = {
      jobId: 'job_permanent_1',
      migrationRunId: 'run_perm',
      batchKey: 'batch_perm',
      sequenceNo: 1,
      sourceObject: 'users',
      destinationObject: 'users',
      cursorStart: null,
      batchSize: 10,
      planVersionId: 'plan_v1',
      mappingVersionId: 'map_v1',
      writeMode: 'insert_only',
    };

    const result = await handler.processJob(payload);

    expect(result.status).toBe('FAILED_PERMANENT');
    const batch = await manifestTracker.getBatch('run_perm', 'batch_perm');
    expect(batch?.status).toBe('FAILED_PERMANENT');
    expect(batch?.errorSummary?.classification).toBe('PERMANENT');
  });

  it('ensures failed batch execution rejects so BullMQ marks job failed instead of completed', async () => {
    const mockRecords: SourceRecordEnvelope[] = [
      {
        sourceObject: 'users',
        sourceKey: 'u1',
        payload: { id: 'u1', email: null },
        extractedAt: new Date().toISOString(),
      },
    ];

    const sourceConnector = new MockSourceConnector(mockRecords);
    const destinationConnector = new MockDestinationConnector();
    destinationConnector.failAtCall = 1;
    destinationConnector.failError = Object.assign(
      new Error('null value in column "email" violates not-null constraint'),
      { code: '23502' },
    );

    const manifestTracker = new BatchManifestTracker();
    const checkpointManager = new CheckpointManager();

    const handler = new QueueHandler({
      sourceConnector,
      destinationConnector,
      manifestTracker,
      checkpointManager,
    });

    const payload: MigrationJobPayload = {
      jobId: 'job_fail_check',
      migrationRunId: 'run_fail',
      batchKey: 'batch_fail',
      sequenceNo: 1,
      sourceObject: 'users',
      destinationObject: 'users',
      cursorStart: null,
      batchSize: 10,
      planVersionId: 'plan_v1',
      mappingVersionId: 'map_v1',
      writeMode: 'insert_only',
    };

    // Worker processor wrapper enforcing BullMQ rejection on uncommitted batch
    const workerProcessor = async (jobPayload: MigrationJobPayload) => {
      const result = await handler.processJob(jobPayload);
      if (result.status !== 'COMMITTED') {
        const errMessage =
          result.error instanceof Error
            ? result.error.message
            : typeof result.error === 'string'
              ? result.error
              : `Batch ${jobPayload.batchKey} failed with status: ${result.status}`;
        throw new Error(`Job execution failed for batch ${jobPayload.batchKey} (${result.status}): ${errMessage}`);
      }
      return result;
    };

    await expect(workerProcessor(payload)).rejects.toThrow(
      /Job execution failed for batch batch_fail \(FAILED_PERMANENT\)/,
    );
  });
});
