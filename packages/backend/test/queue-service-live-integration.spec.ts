import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QueueService, MigrationJobPayload } from '../src/queue/queue.service';
import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';

describe('Backend QueueService Live Redis Integration (Run 005.4)', () => {
  let queueService: QueueService;
  let testWorker: Worker | null = null;
  let testRedisClient: Redis | null = null;
  const isCi = process.env.CI === 'true';

  const redisUrl =
    process.env.REDIS_URL ||
    (process.env.REDIS_HOST
      ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`
      : 'redis://localhost:6379');

  beforeAll(async () => {
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
      await queueService.onModuleDestroy();
    }
    if (testRedisClient) {
      testRedisClient.disconnect();
      testRedisClient = null;
    }
  });

  it('connects actual QueueService to live Redis without connection or TLS errors', async () => {
    if (!testRedisClient || !queueService) return;

    expect(queueService.isQueueConnected).toBe(true);
  });

  it('dispatches a migration batch via QueueService and verifies BullMQ worker consumes it', async () => {
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
        QueueService.QUEUE_NAME,
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
