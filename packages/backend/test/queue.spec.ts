import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { QueueService, MigrationJobPayload } from '../src/queue/queue.service';
import { DatabaseService } from '../src/database/database.service';

describe('QueueService (BullMQ Producer)', () => {
  let queueService: QueueService;
  const unitTestQueue = `test-unit-queue-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  let prevQueueName: string | undefined;

  // Strict safety guards: Queue unit tests must never connect to production Redis
  if (
    process.env.NODE_ENV === 'production' ||
    (process.env.REDIS_URL && /prod/i.test(process.env.REDIS_URL))
  ) {
    throw new Error('[Safety Guard] Queue unit tests must never run against production Redis.');
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    let isLoopback = false;
    try {
      const parsed = new URL(redisUrl);
      isLoopback = DatabaseService.isLoopbackHost(parsed.hostname);
    } catch {
      isLoopback =
        redisUrl.includes('localhost') ||
        redisUrl.includes('127.0.0.1') ||
        redisUrl.includes('::1');
    }
    if (!isLoopback && process.env.ALLOW_REMOTE_TEST_REDIS !== 'true') {
      if (process.env.CI === 'true') {
        throw new Error(
          '[Safety Guard] Refusing to run queue unit tests against remote Redis in CI without explicit ALLOW_REMOTE_TEST_REDIS=true.',
        );
      }
      // In local dev with remote REDIS_URL in .env, isolate unit tests to protect remote instance
      delete process.env.REDIS_URL;
      delete process.env.REDIS_HOST;
    }
  }

  beforeAll(() => {
    prevQueueName = process.env.BULLMQ_QUEUE_NAME;
    process.env.BULLMQ_QUEUE_NAME = unitTestQueue;
    process.env.ALLOW_SIMULATED_DISPATCH = 'true';
  });

  afterAll(async () => {
    delete process.env.ALLOW_SIMULATED_DISPATCH;
    if (prevQueueName) {
      process.env.BULLMQ_QUEUE_NAME = prevQueueName;
    } else {
      delete process.env.BULLMQ_QUEUE_NAME;
    }
  });

  beforeEach(async () => {
    queueService = new QueueService();
    await queueService.onModuleInit();
  });

  afterEach(async () => {
    if (queueService) {
      const q = queueService.getQueue();
      if (q) {
        try {
          await q.drain();
          await q.obliterate({ force: true });
        } catch {}
      }
      await queueService.onModuleDestroy();
    }
  });

  it('should initialize queue service without crashing', () => {
    expect(queueService).toBeDefined();
  });

  it('fails dispatch in production when Redis is disconnected even if ALLOW_SIMULATED_DISPATCH is true', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevSim = process.env.ALLOW_SIMULATED_DISPATCH;
    // Instantiate with a port that does not exist to guarantee disconnected state
    const disconnectedService = new QueueService('redis://127.0.0.1:59999');
    await disconnectedService.onModuleInit();
    expect(disconnectedService.isQueueConnected).toBe(false);

    try {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_SIMULATED_DISPATCH = 'true';

      await expect(
        disconnectedService.dispatchBatchJob({
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
    } finally {
      process.env.NODE_ENV = prevEnv;
      process.env.ALLOW_SIMULATED_DISPATCH = prevSim;
      await disconnectedService.onModuleDestroy();
    }
  });

  it('fails dispatch when Redis is disconnected and simulated dispatch is disabled', async () => {
    const prevSim = process.env.ALLOW_SIMULATED_DISPATCH;
    // Instantiate with a port that does not exist to guarantee disconnected state
    const disconnectedService = new QueueService('redis://127.0.0.1:59999');
    await disconnectedService.onModuleInit();
    expect(disconnectedService.isQueueConnected).toBe(false);

    try {
      delete process.env.ALLOW_SIMULATED_DISPATCH;
      await expect(
        disconnectedService.dispatchBatchJob({
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
    } finally {
      process.env.ALLOW_SIMULATED_DISPATCH = prevSim;
      await disconnectedService.onModuleDestroy();
    }
  });

  it('recovers connected state and queue functionality when Redis reconnects after a transient outage', async () => {
    const testService = new QueueService('redis://127.0.0.1:59999');
    await testService.onModuleInit();
    const redis = testService.getRedisClient();
    expect(redis).toBeDefined();

    // 1. Simulate connected state
    (testService as any).isConnected = true;
    expect(testService.isQueueConnected).toBe(true);

    // 2. Simulate transient outage: connection closes
    redis!.emit('close');
    expect(testService.isQueueConnected).toBe(false);

    // 3. Simulate error during outage
    redis!.emit('error', new Error('Connection refused'));
    expect(testService.isQueueConnected).toBe(false);

    // 4. Simulate automatic recovery: ready event fires
    redis!.emit('ready');
    expect(testService.isQueueConnected).toBe(true);

    await testService.onModuleDestroy();
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
