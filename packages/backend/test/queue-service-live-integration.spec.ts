import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QueueService, MigrationJobPayload } from '../src/queue/queue.service';
import { resolveSafeTestRedisEndpoint, ResolvedRedisTarget } from './redis-test-utils';
import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';

describe('Backend QueueService Live Redis Integration (Run 005.4 & Run 005.5)', () => {
  let queueService: QueueService | null = null;
  let testWorker: Worker | null = null;
  let testWorkerConnection: Redis | null = null;
  let testRedisClient: Redis | null = null;
  let resolvedTarget: ResolvedRedisTarget | null = null;
  const isCi = process.env.CI === 'true';
  const initialEnv = { ...process.env };

  // Isolated queue name to ensure zero state collision with other test suites or default queues
  const uniqueQueueName = `test-live-queue-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  // Evaluate endpoint resolution safely
  try {
    resolvedTarget = resolveSafeTestRedisEndpoint();
  } catch (err: any) {
    if (isCi) {
      throw err;
    }
  }

  const redisUrl = resolvedTarget ? resolvedTarget.url : 'redis://127.0.0.1:6379';
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

    if (!resolvedTarget) {
      console.warn('[Safety Notice] Safe Redis test endpoint not available in local environment, skipping live test.');
      return;
    }

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
        testRedisClient = null;
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
    let cleanupError: any = null;

    // 1. Close workers and worker connections first so no active jobs block queue obliteration
    try {
      if (testWorker) {
        await testWorker.close();
        testWorker = null;
      }
    } catch (err) {
      if (!cleanupError) cleanupError = err;
    }

    try {
      if (testWorkerConnection) {
        testWorkerConnection.disconnect();
        testWorkerConnection = null;
      }
    } catch (err) {
      if (!cleanupError) cleanupError = err;
    }

    // 2. Now drain and obliterate queue
    try {
      if (queueService) {
        const q = queueService.getQueue();
        if (q && queueService.isQueueConnected) {
          await q.drain();
          await q.obliterate({ force: true });
        }
      }
    } catch (err: any) {
      if (!cleanupError) cleanupError = err;
    }

    // 3. Close QueueService and test Redis client
    try {
      if (queueService) {
        await queueService.onModuleDestroy();
        queueService = null;
      }
    } catch (err) {
      if (!cleanupError) cleanupError = err;
    }

    try {
      if (testRedisClient) {
        testRedisClient.disconnect();
        testRedisClient = null;
      }
    } catch (err) {
      if (!cleanupError) cleanupError = err;
    }

    // 4. Always restore process environment
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(initialEnv)) {
      process.env[key] = value;
    }

    if (cleanupError) {
      throw cleanupError;
    }
  });

  it('connects actual QueueService to live Redis without connection or TLS errors', async (ctx) => {
    if (!resolvedTarget || !testRedisClient || !queueService || !queueService.isQueueConnected) {
      ctx.skip();
      return;
    }

    expect(queueService.isQueueConnected).toBe(true);
  });

  it('recovers connection, resumes dispatching, and consumes job after genuine Redis CLIENT KILL disconnect', async (ctx) => {
    if (!resolvedTarget || !testRedisClient || !queueService || !queueService.isQueueConnected) {
      ctx.skip();
      return;
    }

    const redis = queueService.getRedisClient();
    if (!redis) {
      ctx.skip();
      return;
    }

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
      // Register completion listeners BEFORE dispatching the job to eliminate race conditions
      const consumptionPromise = new Promise<void>((resolve, reject) => {
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

      const recoveryJobId = await queueService.dispatchBatchJob(recoveryPayload);
      expect(recoveryJobId).toBe('run-recovery_batch_recovery');

      await consumptionPromise;
      expect(recoveryJobConsumed).toBe(true);
    } finally {
      try {
        await recoveryWorker.close();
      } finally {
        recoveryWorkerConnection.disconnect();
      }
    }

    // Drain the test queue to ensure test 2 jobs do not spill into test 3
    const q = queueService.getQueue();
    if (q && queueService.isQueueConnected) {
      await q.drain();
    }
  });

  it('dispatches a migration batch via QueueService and verifies BullMQ worker consumes it on unique queue', async (ctx) => {
    if (!resolvedTarget || !testRedisClient || !queueService || !queueService.isQueueConnected) {
      ctx.skip();
      return;
    }

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
      testWorkerConnection = createSharedRedisClient({
        enableReadyCheck: false,
        lazyConnect: false,
      });
      testWorkerConnection.on('error', (err) => console.warn('Worker connection warning:', err.message));

      testWorker = new Worker(
        uniqueQueueName,
        async (job: Job) => {
          if (job.id === targetJobId) {
            consumedData = job.data as MigrationJobPayload;
          }
          return { status: 'COMMITTED', recordsProcessed: 100 };
        },
        {
          connection: testWorkerConnection,
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
