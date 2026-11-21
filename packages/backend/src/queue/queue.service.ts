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
  private isDestroyed = false;
  private customRedisUrl?: string;

  constructor(customRedisUrl?: string) {
    this.customRedisUrl = customRedisUrl;
  }

  public static get QUEUE_NAME(): string {
    return process.env.BULLMQ_QUEUE_NAME || 'migration-execution';
  }

  async onModuleInit() {
    await this.initQueue();
  }

  async onModuleDestroy() {
    this.isDestroyed = true;
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        this.redisClient.disconnect();
      }
      this.redisClient = null;
    }
    this.isConnected = false;
  }

  public get isQueueConnected(): boolean {
    return this.isConnected;
  }

  public getQueue(): Queue | null {
    return this.queue;
  }

  public getRedisClient(): Redis | null {
    return this.redisClient;
  }

  private ensureQueue(): void {
    if (!this.queue && this.redisClient) {
      this.queue = new Queue(QueueService.QUEUE_NAME, {
        connection: this.redisClient,
      });
      this.logger.log(`[QueueService] Connected to BullMQ queue: '${QueueService.QUEUE_NAME}'`);
    }
  }

  private async initQueue() {
    try {
      const redisUrl = this.customRedisUrl || process.env.REDIS_URL;
      const isProduction = process.env.NODE_ENV === 'production';
      const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true';

      const isRediss = redisUrl ? redisUrl.startsWith('rediss://') : false;
      const isTls = isRediss || process.env.REDIS_TLS === 'true';
      const tlsConfig = isTls
        ? { rejectUnauthorized: isProduction ? true : !allowInsecureTls }
        : undefined;

      const connectionOptions = {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        connectTimeout: 4000,
        lazyConnect: true,
        retryStrategy: (times: number) => {
          if (this.isDestroyed) {
            return null;
          }
          // Exponential backoff capped at 2 seconds for responsive automatic recovery
          return Math.min(times * 100, 2000);
        },
      };

      if (redisUrl) {
        this.redisClient = new Redis(redisUrl, {
          ...connectionOptions,
          tls: tlsConfig,
        });
      } else {
        this.redisClient = new Redis({
          host: appConfig.redis.host,
          port: appConfig.redis.port,
          password: appConfig.redis.password || undefined,
          tls: tlsConfig,
          ...connectionOptions,
        });
      }

      this.redisClient.on('ready', () => {
        this.isConnected = true;
        this.ensureQueue();
        this.logger.log(`[QueueService] Redis connection ready. Queue '${QueueService.QUEUE_NAME}' active.`);
      });

      this.redisClient.on('close', () => {
        this.isConnected = false;
        this.logger.warn(`[QueueService] Redis connection closed. Queue dispatch paused.`);
      });

      this.redisClient.on('error', (err) => {
        this.logger.warn(`[QueueService] Redis connection error: ${err.message}`);
        this.isConnected = false;
      });

      // Probe connection to ensure queue is active
      try {
        await this.redisClient.connect();
        await this.redisClient.ping();
        this.isConnected = true;
        this.ensureQueue();
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
      if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SIMULATED_DISPATCH !== 'true') {
        this.logger.error(
          `[QueueService] Failed to dispatch job ${deterministicJobId}: Queue is offline or Redis is disconnected.`,
        );
        throw new Error(
          `[QueueService] Cannot dispatch batch job: Queue is offline or Redis is disconnected. Simulated dispatch is forbidden.`,
        );
      }
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
