import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { QueueService, MigrationJobPayload } from '../src/queue/queue.service';

describe('QueueService (BullMQ Producer)', () => {
  let queueService: QueueService;

  beforeAll(() => {
    process.env.ALLOW_SIMULATED_DISPATCH = 'true';
  });

  afterAll(() => {
    delete process.env.ALLOW_SIMULATED_DISPATCH;
  });

  beforeEach(async () => {
    queueService = new QueueService();
    await queueService.onModuleInit();
  });

  afterEach(async () => {
    await queueService.onModuleDestroy();
  });

  it('should initialize queue service without crashing', () => {
    expect(queueService).toBeDefined();
  });

  it('fails dispatch in production when Redis is disconnected even if ALLOW_SIMULATED_DISPATCH is true', async () => {
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      // If queue is disconnected in this unit environment
      if (!queueService.isQueueConnected) {
        await expect(
          queueService.dispatchBatchJob({
            jobId: 'run-prod_batch_0001',
            migrationRunId: 'run-prod',
            batchKey: 'batch_0001',
            sequenceNo: 1,
            sourceObject: 'customers',
            destinationObject: 'customers',
            cursorStart: null,
            batchSize: 100,
            planVersionId: 'plan-v1',
            mappingVersionId: 'map-v1',
            writeMode: 'upsert',
          }),
        ).rejects.toThrow(/Cannot dispatch batch job: Queue is offline or Redis is disconnected/);
      }
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it('fails dispatch when Redis is disconnected and simulated dispatch is disabled', async () => {
    const prevSim = process.env.ALLOW_SIMULATED_DISPATCH;
    try {
      delete process.env.ALLOW_SIMULATED_DISPATCH;
      if (!queueService.isQueueConnected) {
        await expect(
          queueService.dispatchBatchJob({
            jobId: 'run-fail_batch_0001',
            migrationRunId: 'run-fail',
            batchKey: 'batch_0001',
            sequenceNo: 1,
            sourceObject: 'customers',
            destinationObject: 'customers',
            cursorStart: null,
            batchSize: 100,
            planVersionId: 'plan-v1',
            mappingVersionId: 'map-v1',
            writeMode: 'upsert',
          }),
        ).rejects.toThrow(/Simulated dispatch is forbidden/);
      }
    } finally {
      process.env.ALLOW_SIMULATED_DISPATCH = prevSim;
    }
  });

  it('should generate deterministic Job IDs and dispatch job', async () => {
    const payload: MigrationJobPayload = {
      jobId: 'run-001_batch_0001',
      migrationRunId: 'run-001',
      batchKey: 'batch_0001',
      sequenceNo: 1,
      sourceObject: 'customers',
      destinationObject: 'customers',
      cursorStart: null,
      batchSize: 1000,
      planVersionId: 'plan-v1',
      mappingVersionId: 'map-v1',
      writeMode: 'upsert',
    };

    const jobId = await queueService.dispatchBatchJob(payload);
    expect(jobId).toBe('run-001_batch_0001');
  });

  it('should dispatch multiple batch jobs in sequence', async () => {
    const payloads: MigrationJobPayload[] = [
      {
        jobId: 'run-002_batch_0001',
        migrationRunId: 'run-002',
        batchKey: 'batch_0001',
        sequenceNo: 1,
        sourceObject: 'customers',
        destinationObject: 'customers',
        cursorStart: null,
        batchSize: 500,
        planVersionId: 'plan-v1',
        mappingVersionId: 'map-v1',
        writeMode: 'insert_only',
      },
      {
        jobId: 'run-002_batch_0002',
        migrationRunId: 'run-002',
        batchKey: 'batch_0002',
        sequenceNo: 2,
        sourceObject: 'customers',
        destinationObject: 'customers',
        cursorStart: { offset: 500 },
        batchSize: 500,
        planVersionId: 'plan-v1',
        mappingVersionId: 'map-v1',
        writeMode: 'insert_only',
      },
    ];

    const jobIds = await queueService.dispatchBatches(payloads);
    expect(jobIds).toHaveLength(2);
    expect(jobIds[0]).toBe('run-002_batch_0001');
    expect(jobIds[1]).toBe('run-002_batch_0002');
  });
});
