import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QueueService, MigrationJobPayload } from '../src/queue/queue.service';
import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';

describe('Backend QueueService Live Redis Integration (Run 005.4 & Run 005.5)', () => {
  let queueService: QueueService;
  let testWorker: Worker | null = null;
  let testRedisClient: Redis | null = null;
  const isCi = process.env.CI === 'true';
  const initialEnv = { ...process.env };

  // Isolated queue name to ensure zero state collision with other test suites or default queues
  const uniqueQueueName = `test-live-queue-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  const redisUrl =
    process.env.MIGRATIONGUARD_TEST_REDIS_URL ||
    process.env.TEST_REDIS_URL ||
    process.env.REDIS_URL ||
    (process.env.REDIS_HOST
      ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`
      : 'redis://localhost:6379');

  const isRediss = redisUrl.startsWith('rediss://');
  const isTls = isRediss || process.env.REDIS_TLS === 'true';
  const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true';
  const isProduction = process.env.NODE_ENV === 'production';
  const sharedTlsConfig = isTls
    ? { rejectUnauthorized: isProduction ? true : !allowInsecureTls }
    : undefined;

  function createSharedRedisClient(options: Record<string, any> = {}): Redis {
    return new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      tls: sharedTlsConfig,
      ...options,
    });
  }

  beforeAll(async () => {
    delete process.env.ALLOW_SIMULATED_DISPATCH;
    process.env.BULLMQ_QUEUE_NAME = uniqueQueueName;

    // Probe Redis connectivity first with lazy connect
    try {
      testRedisClient = createSharedRedisClient({
        connectTimeout: 4000,
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
      if (q && queueService.isQueueConnected) {
        await q.drain();
        await q.obliterate({ force: true });
      }
      await queueService.onModuleDestroy();
    }
    if (testRedisClient) {
      testRedisClient.disconnect();
      testRedisClient = null;
    }
    // Restore process environment
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(initialEnv)) {
      process.env[key] = value;
    }
  });

  it('connects actual QueueService to live Redis without connection or TLS errors', async () => {
    if (!testRedisClient || !queueService) return;

    expect(queueService.isQueueConnected).toBe(true);
  });

  it('recovers connection, resumes dispatching, and consumes job after genuine Redis CLIENT KILL disconnect', async () => {
    if (!testRedisClient || !queueService || !queueService.isQueueConnected) return;

    const redis = queueService.getRedisClient();
    if (!redis) return;

    expect(queueService.isQueueConnected).toBe(true);

    // 1. Capture client ID of queueService's redis connection
    const rawClientId = await redis.client('ID');
    const clientId = String(rawClientId);

    const closePromise = new Promise<void>((resolve) => {
      if (!queueService.isQueueConnected) return resolve();
      redis.once('close', () => resolve());
    });

    const readyPromise = new Promise<void>((resolve) => {
      redis.once('ready', () => resolve());
    });

    // 2. Terminate connection from server-side using admin client (genuine connection interruption)
    await testRedisClient.client('KILL', 'ID', clientId, 'SKIPME', 'YES');

    // 3. Await genuine socket disconnect
    await Promise.race([
      closePromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for Redis client close event after CLIENT KILL')), 4000),
      ),
    ]);
    expect(queueService.isQueueConnected).toBe(false);

    // 4. Dispatches in disconnected state must fail-closed
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

    // 5. Await genuine automatic reconnection via retryStrategy & ready event
    await Promise.race([
      readyPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for Redis automatic reconnection ready event')), 8000),
      ),
    ]);
    expect(queueService.isQueueConnected).toBe(true);

    // 6. Verify recovery allows dispatch and actual BullMQ worker consumption
    const recoveryPayload: MigrationJobPayload = {
      jobId: 'run-recovery_batch_recovery',
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
    };

    const recoveryWorkerConnection = createSharedRedisClient({
      enableReadyCheck: false,
      lazyConnect: false,
    });
    recoveryWorkerConnection.on('error', () => {});

    let recoveryJobConsumed = false;
    const recoveryWorker = new Worker(
      uniqueQueueName,
      async (job: Job) => {
        if (job.id === 'run-recovery_batch_recovery') {
          recoveryJobConsumed = true;
        }
        return { status: 'COMMITTED' };
      },
      {
        connection: recoveryWorkerConnection,
        concurrency: 1,
      },
    );

    try {
      const recoveryJobId = await queueService.dispatchBatchJob(recoveryPayload);
      expect(recoveryJobId).toBe('run-recovery_batch_recovery');

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for recovery job consumption by worker')),
          8000,
        );
        recoveryWorker.on('completed', (job: Job) => {
          if (job.id === 'run-recovery_batch_recovery') {
            clearTimeout(timeout);
            resolve();
          }
        });
        recoveryWorker.on('failed', (_, err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      expect(recoveryJobConsumed).toBe(true);
    } finally {
      await recoveryWorker.close();
      recoveryWorkerConnection.disconnect();
    }

    // Drain the test queue to ensure test 2 jobs do not spill into test 3
    const q = queueService.getQueue();
    if (q && queueService.isQueueConnected) {
      await q.drain();
    }
  });

  it('dispatches a migration batch via QueueService and verifies BullMQ worker consumes it on unique queue', async () => {
    if (!testRedisClient || !queueService || !queueService.isQueueConnected) return;

    // Ensure queue is clean before dispatching test 3 job
    const q = queueService.getQueue();
    if (q && queueService.isQueueConnected) {
      await q.drain();
    }

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

    const targetJobId = `${payload.migrationRunId}_${payload.batchKey}`;
    let consumedData: MigrationJobPayload | null = null;

    const jobPromise = new Promise<{ id: string; data: MigrationJobPayload }>((resolve, reject) => {
      const workerConnection = createSharedRedisClient({
        enableReadyCheck: false,
        lazyConnect: false,
      });
      workerConnection.on('error', (err) => console.warn('Worker connection warning:', err.message));

      testWorker = new Worker(
        uniqueQueueName,
        async (job: Job) => {
          if (job.id === targetJobId) {
            consumedData = job.data as MigrationJobPayload;
          }
          return { status: 'COMMITTED', recordsProcessed: 100 };
        },
        {
          connection: workerConnection,
          concurrency: 1,
        },
      );

      testWorker.on('completed', (job: Job) => {
        if (job.id === targetJobId) {
          resolve({ id: job.id!, data: job.data });
        }
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
