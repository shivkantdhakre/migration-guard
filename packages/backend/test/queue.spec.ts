import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { QueueService, MigrationJobPayload } from '../src/queue/queue.service';
import { resolveSafeTestRedisEndpoint } from './redis-test-utils';

describe('QueueService (BullMQ Producer)', () => {
  let queueService: QueueService;
  const initialEnv = { ...process.env };
  const unitTestQueue = `test-unit-queue-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const isCi = process.env.CI === 'true';

  let effectiveTestRedisUrl = 'redis://127.0.0.1:6379';
  try {
    const target = resolveSafeTestRedisEndpoint();
    effectiveTestRedisUrl = target.url;
  } catch (err: any) {
    if (isCi) {
      throw new Error(`[CI Mandatory Failure] ${err.message}`);
    }
    // In local dev where generic REDIS_URL in .env is remote, isolate unit tests to loopback (detached mode)
    effectiveTestRedisUrl = 'redis://127.0.0.1:6379';
  }

  beforeAll(() => {
    process.env.BULLMQ_QUEUE_NAME = unitTestQueue;
    process.env.ALLOW_SIMULATED_DISPATCH = 'true';
  });

  afterAll(async () => {
    // Restore all process environment variables to their original snapshot
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(initialEnv)) {
      process.env[key] = value;
    }
  });

  beforeEach(async () => {
    queueService = new QueueService(effectiveTestRedisUrl);
    await queueService.onModuleInit();
  });

  afterEach(async () => {
    let cleanupError: any = null;
    try {
      if (queueService) {
        const q = queueService.getQueue();
        if (q && queueService.isQueueConnected) {
          await q.drain();
          await q.obliterate({ force: true });
        }
      }
    } catch (err: any) {
      cleanupError = err;
    } finally {
      if (queueService) {
        await queueService.onModuleDestroy();
      }
    }
    if (cleanupError) {
      throw cleanupError;
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

  it('unit: transitions isConnected flag and updates queue state on close, error, and ready lifecycle events', async () => {
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

  it('rejects remote generic REDIS_URL even when ALLOW_REMOTE_TEST_REDIS is true', () => {
    const prevUrl = process.env.REDIS_URL;
    const prevRemote = process.env.ALLOW_REMOTE_TEST_REDIS;
    const prevTestUrl = process.env.MIGRATIONGUARD_TEST_REDIS_URL;
    const prevTestUrlAlt = process.env.TEST_REDIS_URL;
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'test';
      delete process.env.MIGRATIONGUARD_TEST_REDIS_URL;
      delete process.env.TEST_REDIS_URL;
      process.env.REDIS_URL = 'redis://cache-01.example.net:6379';
      process.env.ALLOW_REMOTE_TEST_REDIS = 'true';

      expect(() => {
        resolveSafeTestRedisEndpoint();
      }).toThrow(/Generic application Redis endpoint .* cannot be used for remote testing/);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      process.env.REDIS_URL = prevUrl;
      process.env.ALLOW_REMOTE_TEST_REDIS = prevRemote;
      if (prevTestUrl) process.env.MIGRATIONGUARD_TEST_REDIS_URL = prevTestUrl;
      if (prevTestUrlAlt) process.env.TEST_REDIS_URL = prevTestUrlAlt;
    }
  });

  it('strictly forbids testing against production environments regardless of configuration', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => {
        resolveSafeTestRedisEndpoint();
      }).toThrow(/Redis tests must never run in production environment/);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });
});
