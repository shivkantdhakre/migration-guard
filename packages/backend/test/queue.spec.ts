import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { QueueService, MigrationJobPayload } from '../src/queue/queue.service';
import { DatabaseService } from '../src/database/database.service';
import { appConfig } from '../src/config/configuration';

describe('QueueService (BullMQ Producer)', () => {
  let queueService: QueueService;
  const initialEnv = { ...process.env };
  const unitTestQueue = `test-unit-queue-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  // Resolve and validate the effective Redis endpoint (checking designated test URL, REDIS_URL, REDIS_HOST, and appConfig.redis)
  const effectiveTarget = (() => {
    const designatedTestUrl =
      process.env.MIGRATIONGUARD_TEST_REDIS_URL || process.env.TEST_REDIS_URL;
    if (designatedTestUrl) {
      try {
        const parsed = new URL(designatedTestUrl);
        return {
          host: parsed.hostname,
          port: parsed.port || '6379',
          source: 'MIGRATIONGUARD_TEST_REDIS_URL',
          url: designatedTestUrl,
        };
      } catch {
        return {
          host: designatedTestUrl,
          port: '6379',
          source: 'MIGRATIONGUARD_TEST_REDIS_URL',
          url: designatedTestUrl,
        };
      }
    }
    if (process.env.REDIS_URL) {
      try {
        const parsed = new URL(process.env.REDIS_URL);
        return {
          host: parsed.hostname,
          port: parsed.port || '6379',
          source: 'REDIS_URL',
          url: process.env.REDIS_URL,
        };
      } catch {
        return {
          host: process.env.REDIS_URL,
          port: '6379',
          source: 'REDIS_URL',
          url: process.env.REDIS_URL,
        };
      }
    }
    const host = process.env.REDIS_HOST || appConfig.redis.host || 'localhost';
    const port = String(process.env.REDIS_PORT || appConfig.redis.port || '6379');
    return {
      host,
      port,
      source: process.env.REDIS_HOST ? 'REDIS_HOST' : 'appConfig.redis.host',
      url: undefined,
    };
  })();

  // 1. Strict production guard: Queue unit tests must never connect to production Redis
  const isProductionTarget =
    process.env.NODE_ENV === 'production' ||
    process.env.REDIS_ENV === 'production' ||
    /prod/i.test(effectiveTarget.host) ||
    (effectiveTarget.url ? /prod/i.test(effectiveTarget.url) : false);

  if (isProductionTarget) {
    throw new Error(
      `[Safety Guard] Queue unit tests must never connect to production Redis (${effectiveTarget.host} via ${effectiveTarget.source}).`,
    );
  }

  // 2. Strict remote guard: Remote endpoints strictly require ALLOW_REMOTE_TEST_REDIS=true
  const isTargetLoopback = DatabaseService.isLoopbackHost(effectiveTarget.host);
  if (!isTargetLoopback && process.env.ALLOW_REMOTE_TEST_REDIS !== 'true') {
    if (process.env.CI === 'true') {
      throw new Error(
        `[Safety Guard] Refusing to run queue unit tests against remote Redis (${effectiveTarget.host} via ${effectiveTarget.source}) in CI without explicit ALLOW_REMOTE_TEST_REDIS=true.`,
      );
    }
  }

  // Determine explicit isolated test Redis URL:
  // In loopback or explicitly authorized environments, use the target; otherwise route to local loopback
  const effectiveTestRedisUrl = (() => {
    if (effectiveTarget.url && (isTargetLoopback || process.env.ALLOW_REMOTE_TEST_REDIS === 'true')) {
      return effectiveTarget.url;
    }
    if (isTargetLoopback) {
      return `redis://${effectiveTarget.host}:${effectiveTarget.port}`;
    }
    // Protect remote development Redis instance from unit test execution
    return 'redis://127.0.0.1:6379';
  })();

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
    if (queueService) {
      const q = queueService.getQueue();
      if (q && queueService.isQueueConnected) {
        await q.drain();
        await q.obliterate({ force: true });
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
});
