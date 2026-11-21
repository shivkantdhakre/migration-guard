import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QueueService, MigrationJobPayload } from '../src/queue/queue.service';
import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';

describe('Backend QueueService Live Redis Integration (Run 005.4 & Run 005.5)', () => {
  let queueService: QueueService;
  let testWorker: Worker | null = null;
  let testRedisClient: Redis | null = null;
  const isCi = process.env.CI === 'true';

  // Isolated queue name to ensure zero state collision with other test suites or default queues
  const uniqueQueueName = `test-live-queue-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const prevQueueName = process.env.BULLMQ_QUEUE_NAME;

  const redisUrl =
    process.env.REDIS_URL ||
    (process.env.REDIS_HOST
      ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`
      : 'redis://localhost:6379');

  beforeAll(async () => {
    process.env.BULLMQ_QUEUE_NAME = uniqueQueueName;

    // Probe Redis connectivity first with lazy connect
    try {
      testRedisClient = new Redis(redisUrl, {
        connectTimeout: 4000,
        maxRetriesPerRequest: null,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      testRedisClient.on('error', () => {});
      await testRedisClient.connect();
      await testRedisClient.ping();
    } catch (err: any) {
      if (testRedisClient) {
        testRedisClient.disconnect();
      }
      if (isCi) {
        throw new Error(`[CI Mandatory Failure] Live Redis is unreachable in CI environment: ${err.message}`);
      }
      console.warn('[Notice] Live Redis unreachable in local environment, skipping QueueService live integration test.');
      return;
    }

    queueService = new QueueService(redisUrl);
    await queueService.onModuleInit();
  });

  afterAll(async () => {
    if (testWorker) {
      await testWorker.close();
      testWorker = null;
    }
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
    if (testRedisClient) {
      testRedisClient.disconnect();
      testRedisClient = null;
    }
    if (prevQueueName) {
      process.env.BULLMQ_QUEUE_NAME = prevQueueName;
    } else {
      delete process.env.BULLMQ_QUEUE_NAME;
    }
  });

  it('connects actual QueueService to live Redis without connection or TLS errors', async () => {
    if (!testRedisClient || !queueService) return;

    expect(queueService.isQueueConnected).toBe(true);
  });

  it('recovers connection and resumes dispatching after a simulated disconnect on live Redis', async () => {
    if (!testRedisClient || !queueService || !queueService.isQueueConnected) return;

    const redis = queueService.getRedisClient();
    if (!redis) return;

    expect(queueService.isQueueConnected).toBe(true);

    // 1. Simulate transient outage: connection closes
    redis.emit('close');
    expect(queueService.isQueueConnected).toBe(false);

    // 2. Dispatches in disconnected state must fail-closed
    await expect(
      queueService.dispatchBatchJob({
        jobId: 'test_transient_job',
        migrationRunId: 'run-transient',
        batchKey: 'batch_transient',
        sequenceNo: 99,
        sourceObject: 'customers',
        destinationObject: 'customers',
        cursorStart: null,
        batchSize: 10,
        planVersionId: 'plan-v1',
        mappingVersionId: 'map-v1',
        writeMode: 'upsert',
      }),
    ).rejects.toThrow(/Queue is offline or Redis is disconnected/);

    // 3. Simulate automatic reconnection / recovery: ready event fires
    redis.emit('ready');
    expect(queueService.isQueueConnected).toBe(true);

    // 4. Verify recovery allows immediate dispatch
    const recoveryJobId = await queueService.dispatchBatchJob({
      jobId: 'test_recovery_job',
      migrationRunId: 'run-recovery',
      batchKey: 'batch_recovery',
      sequenceNo: 100,
      sourceObject: 'customers',
      destinationObject: 'customers',
      cursorStart: null,
      batchSize: 10,
      planVersionId: 'plan-v1',
      mappingVersionId: 'map-v1',
      writeMode: 'upsert',
    });
    expect(recoveryJobId).toBe('run-recovery_batch_recovery');
  });

  it('dispatches a migration batch via QueueService and verifies BullMQ worker consumes it on unique queue', async () => {
    if (!testRedisClient || !queueService || !queueService.isQueueConnected) return;

    const testRunId = `run-live-${Date.now()}`;
    const payload: MigrationJobPayload = {
      jobId: `${testRunId}_batch_customers_0001`,
      migrationRunId: testRunId,
      batchKey: 'batch_customers_0001',
      sequenceNo: 1,
      sourceObject: 'customers',
      destinationObject: 'customers',
      cursorStart: null,
      cursorEnd: { offset: 100 },
      batchSize: 100,
      planVersionId: 'plan-v1',
      mappingVersionId: 'map-v1',
      writeMode: 'upsert',
    };

    let consumedData: MigrationJobPayload | null = null;

    const jobPromise = new Promise<{ id: string; data: MigrationJobPayload }>((resolve, reject) => {
      const workerConnection = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: false,
      });
      workerConnection.on('error', (err) => console.warn('Worker connection warning:', err.message));

      testWorker = new Worker(
        uniqueQueueName,
        async (job: Job) => {
          consumedData = job.data as MigrationJobPayload;
          return { status: 'COMMITTED', recordsProcessed: 100 };
        },
        {
          connection: workerConnection,
          concurrency: 1,
        },
      );

      testWorker.on('completed', (job: Job) => {
        resolve({ id: job.id!, data: job.data });
      });

      testWorker.on('failed', (job, err) => {
        reject(err);
      });

      testWorker.on('error', (err) => {
        reject(err);
      });
    });

    // Dispatch using the actual backend QueueService
    const dispatchedJobId = await queueService.dispatchBatchJob(payload);
    expect(dispatchedJobId).toBe(`${payload.migrationRunId}_${payload.batchKey}`);

    // Await actual BullMQ worker consumption from live Redis
    const completedJob = await Promise.race([
      jobPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for BullMQ worker to consume job')), 10000),
      ),
    ]);

    expect(completedJob.id).toBe(dispatchedJobId);
    expect(consumedData).not.toBeNull();
    expect(consumedData!.migrationRunId).toBe(payload.migrationRunId);
    expect(consumedData!.batchKey).toBe(payload.batchKey);
    expect(consumedData!.sequenceNo).toBe(payload.sequenceNo);

    console.log(
      '[Backend QueueService Live Integration] Verified QueueService batch dispatch and worker consumption on live Redis.',
    );
  });
});
