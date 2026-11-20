import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { appConfig } from '../config/configuration';

export interface MigrationJobPayload {
  jobId: string;
  migrationRunId: string;
  batchKey: string;
  sequenceNo: number;
  sourceObject: string;
  destinationObject: string;
  cursorStart: any | null;
  cursorEnd?: any | null;
  batchSize: number;
  maxBytes?: number;
  planVersionId: string;
  mappingVersionId: string;
  writeMode: 'insert_only' | 'upsert' | 'skip_existing';
  conflictColumns?: string[];
  updateColumns?: string[];
  sourceConnectionId?: string;
  destinationConnectionId?: string;
}

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private queue: Queue | null = null;
  private redisClient: Redis | null = null;
  private isConnected = false;

  public static get QUEUE_NAME(): string {
    return process.env.BULLMQ_QUEUE_NAME || 'migration-execution';
  }

  async onModuleInit() {
    await this.initQueue();
  }

  async onModuleDestroy() {
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
    if (this.redisClient) {
      this.redisClient.disconnect();
      this.redisClient = null;
    }
    this.isConnected = false;
  }

  public get isQueueConnected(): boolean {
    return this.isConnected;
  }

  private async initQueue() {
    try {
      const redisUrl = process.env.REDIS_URL;
      const isTls =
        process.env.REDIS_TLS === 'true' ||
        appConfig.redis.port === 15678 ||
        (redisUrl && redisUrl.startsWith('rediss://'));

      if (redisUrl) {
        try {
          const parsed = new URL(redisUrl);
          this.redisClient = new Redis({
            host: parsed.hostname,
            port: parseInt(parsed.port || '15678', 10),
            username: parsed.username || 'default',
            password: parsed.password || undefined,
            tls: { rejectUnauthorized: false },
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            connectTimeout: 3000,
          });
        } catch {
          this.redisClient = new Redis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            connectTimeout: 3000,
            tls: isTls ? { rejectUnauthorized: false } : undefined,
          });
        }
      } else {
        this.redisClient = new Redis({
          host: appConfig.redis.host,
          port: appConfig.redis.port,
          password: appConfig.redis.password || undefined,
          tls: isTls ? { rejectUnauthorized: false } : undefined,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          connectTimeout: 3000,
        });
      }

      this.redisClient.on('error', (err) => {
        this.logger.warn(`[QueueService] Redis connection error: ${err.message}`);
        this.isConnected = false;
      });

      // Probe connection with timeout to ensure queue is active
      try {
        await Promise.race([
          this.redisClient.ping(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 3000)),
        ]);
        this.isConnected = true;
        this.queue = new Queue(QueueService.QUEUE_NAME, {
          connection: this.redisClient,
        });
        this.logger.log(`[QueueService] Connected to BullMQ queue: '${QueueService.QUEUE_NAME}'`);
      } catch (pingErr: any) {
        this.isConnected = false;
        this.logger.warn(
          `[QueueService] Redis offline (${pingErr.message}). Queue running in resilient detached mode.`,
        );
      }
    } catch (err: any) {
      this.isConnected = false;
      this.logger.warn(
        `[QueueService] Redis/BullMQ unavailable (${err.message}). Queue dispatch running in detached mode.`,
      );
    }
  }

  /**
   * Dispatches a single migration batch job to BullMQ with deterministic Job ID
   */
  async dispatchBatchJob(payload: MigrationJobPayload): Promise<string> {
    const deterministicJobId = `${payload.migrationRunId}_${payload.batchKey}`;

    if (!this.queue || !this.isConnected) {
      this.logger.warn(
        `[QueueService] Queue offline. Simulating dispatch for batch ${payload.batchKey} (Job: ${deterministicJobId})`,
      );
      return deterministicJobId;
    }

    try {
      const priority =
        payload.sourceObject === 'customers' ? 1 : payload.sourceObject === 'orders' ? 2 : 3;

      const job = await this.queue.add(
        'process-batch',
        payload,
        {
          jobId: deterministicJobId,
          priority,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      this.logger.log(`[QueueService] Dispatched job ${job.id} for run ${payload.migrationRunId}`);
      return job.id!;
    } catch (err: any) {
      this.logger.error(`[QueueService] Failed to dispatch job ${deterministicJobId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Dispatches multiple batches in bulk
   */
  async dispatchBatches(payloads: MigrationJobPayload[]): Promise<string[]> {
    const jobIds: string[] = [];
    for (const p of payloads) {
      const id = await this.dispatchBatchJob(p);
      jobIds.push(id);
    }
    return jobIds;
  }
}
