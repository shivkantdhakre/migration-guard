import { describe, expect, it } from 'vitest';
import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { validateSafeTestRedisEndpoint } from './helpers/postgres-test-utils.js';

describe('BullMQ Redis Live Integration (Run 005.1)', () => {
  it('enqueues a BullMQ job, consumes it with an actual worker, and verifies completion on live Redis', async (ctx) => {
    const redisUrl =
      process.env.MIGRATIONGUARD_TEST_REDIS_URL || process.env.TEST_REDIS_URL;

    if (!redisUrl) {
      if (process.env.CI === 'true') {
        throw new Error('[CI Mandatory Failure] MIGRATIONGUARD_TEST_REDIS_URL or TEST_REDIS_URL is required in CI.');
      }
      console.warn('[Safety Guard] MIGRATIONGUARD_TEST_REDIS_URL or TEST_REDIS_URL not set. Skipping live Redis test.');
      ctx.skip();
      return;
    }

    try {
      validateSafeTestRedisEndpoint(redisUrl);
    } catch (err: any) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] ${err.message}`);
      }
      console.warn(`[Safety Guard] Redis test endpoint rejected: ${err.message}`);
      ctx.skip();
      return;
    }

    // Test connectivity first with ioredis
    let testClient: Redis | null = null;
    try {
      testClient = new Redis(redisUrl, {
        connectTimeout: 4000,
        maxRetriesPerRequest: null,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      testClient.on('error', () => {}); // swallow unhandled error events during test probing
      await testClient.connect();
      await testClient.ping();
    } catch (err: any) {
      if (testClient) {
        testClient.disconnect();
      }
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] Live Redis is unreachable in CI environment: ${err.message}`);
      }
      console.warn('[Notice] Live Redis unreachable in local environment, skipping live BullMQ Redis test.');
      return;
    }

    const queueName = `test-live-queue-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const connectionOptions = {
      host: testClient.options.host || 'localhost',
      port: testClient.options.port || 6379,
      password: testClient.options.password,
      tls: testClient.options.tls,
      maxRetriesPerRequest: null,
    };

    const queue = new Queue(queueName, { connection: connectionOptions });
    let worker: Worker | null = null;

    try {
      const testJobPayload = {
        migrationRunId: `run-${Date.now()}`,
        batchKey: 'batch_customers_0001',
        sequenceNo: 1,
        testMarker: 'bullmq-live-integration-run005.1',
      };

      let processedPayload: any = null;

      const jobProcessedPromise = new Promise<{ id: string; result: any }>((resolve, reject) => {
        worker = new Worker(
          queueName,
          async (job: Job) => {
            processedPayload = job.data;
            return { status: 'COMMITTED', recordsProcessed: 100 };
          },
          {
            connection: connectionOptions,
            concurrency: 1,
          },
        );

        worker.on('completed', (job: Job, returnvalue: any) => {
          resolve({ id: job.id!, result: returnvalue });
        });

        worker.on('failed', (job: Job | undefined, err: Error) => {
          reject(err);
        });

        worker.on('error', (err: Error) => {
          reject(err);
        });
      });

      // Enqueue a real BullMQ job
      const enqueuedJob = await queue.add('execute-batch', testJobPayload, {
        removeOnComplete: true,
        removeOnFail: true,
      });

      expect(enqueuedJob.id).toBeDefined();

      // Wait for completion from the actual worker process
      const { id, result } = await jobProcessedPromise;
      expect(id).toBe(enqueuedJob.id);
      expect(result).toEqual({ status: 'COMMITTED', recordsProcessed: 100 });
      expect(processedPayload).toEqual(testJobPayload);

      console.log(
        '[Redis Live Integration] Verified BullMQ job enqueue, worker consumption, and completion against live Redis.',
      );
    } finally {
      if (worker) {
        await (worker as Worker).close();
      }
      await queue.close();
      if (testClient) {
        await testClient.quit().catch(() => testClient?.disconnect());
      }
    }
  });
});
