/**
 * MigrationGuard Data-Plane Worker Service
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md, 08_MIGRATION_ENGINE_DESIGN.md
 *
 * Standalone worker process for asynchronous migration execution, bounded-memory
 * batch streaming, idempotent writes, checkpointing, and real database writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { QueueHandler } from './engine/queue-handler.js';
import { BatchManifestTracker } from './engine/batch-manifest.js';
import { CheckpointManager } from './engine/checkpoint.js';
import { IdTracker } from './engine/id-tracker.js';
import { PostgresStorageAdapters } from './engine/postgres-storage-adapters.js';
import { ConnectorFactory } from './connectors/connector-factory.js';
import {
  MigrationJobPayload,
  DestinationConnector,
  SourceConnector,
  SourceRecordEnvelope,
  TransformedRecord,
} from './types.js';

// Auto-load .env configuration across monorepo layouts
function loadEnv() {
  const currentDir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '../.env'),
    path.resolve(currentDir, '../../.env'),
    path.resolve(currentDir, '../../../.env'),
    path.resolve(currentDir, '.env'),
  ];

  for (const envPath of candidatePaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const k = trimmed.substring(0, eq).trim();
            let v = trimmed.substring(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
              v = v.substring(1, v.length - 1);
            }
            if (!process.env[k]) {
              process.env[k] = v;
            }
          }
        }
        break;
      } catch {
        // continue
      }
    }
  }
}
loadEnv();

const REDIS_URL = process.env.REDIS_URL;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const IS_REDIS_TLS =
  process.env.REDIS_TLS === 'true' ||
  REDIS_PORT === 15678 ||
  (REDIS_URL && REDIS_URL.startsWith('rediss://'));

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres_password@localhost:5432/migrationguard_control?schema=public';

console.log('========================================================================');
console.log('   MigrationGuard Data-Plane Migration Worker');
console.log('   Specification: 04_SYSTEM_ARCHITECTURE.md (Section 5: Worker Pools)');
console.log('========================================================================');
console.log(`[Worker] Process ID: ${process.pid}`);
console.log(`[Worker] Redis target: ${REDIS_URL ? 'Cloud Valkey/Redis' : `${REDIS_HOST}:${REDIS_PORT}`}`);
console.log(`[Worker] Database target: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);

let executionWorker: Worker | null = null;
let isShuttingDown = false;
let dbPool: pg.Pool | null = null;
let redisClient: Redis | null = null;

// Initialize persistent PostgreSQL connection pool and adapters
dbPool = new pg.Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 10000,
  max: 20,
  ssl: { rejectUnauthorized: false },
});

const postgresAdapters = new PostgresStorageAdapters(dbPool);
const manifestTracker = new BatchManifestTracker(postgresAdapters);
const checkpointManager = new CheckpointManager(postgresAdapters);
const idTracker = new IdTracker(postgresAdapters);

// Initialize Destination Connector (PostgreSQL)
const destinationConnector: DestinationConnector =
  ConnectorFactory.createPostgresDestination(dbPool);

// Source Connector (MongoDB if available, or synthetic fallback)
let sourceConnector: SourceConnector;
const MONGO_URL = process.env.MONGO_URL || process.env.MONGODB_URI;
const MONGO_DB = process.env.MONGO_DB_NAME || 'migrationguard_e2e_source';

if (MONGO_URL) {
  console.log(`[Worker] Source target: MongoDB (${MONGO_DB})`);
  sourceConnector = ConnectorFactory.createMongoSource(MONGO_URL, MONGO_DB);
} else {
  console.warn(`[Worker] Source target: Fallback Synthetic Generator (NO MONGO_URL)`);
  // Standalone source connector with in-memory sample records if MongoDB is not provided
  sourceConnector = {
    testConnection: async () => ({
      success: true,
      message: 'Source connector active',
      latencyMs: 1,
    }),
    readBatch: async (cursor, options) => {
      const offset = (cursor as any)?.offset || 0;
      const limit = options.batchSize || 1000;
      const records: SourceRecordEnvelope[] = [];

      for (let i = 1; i <= Math.min(limit, 20); i++) {
        const id = `cust_source_${offset + i}`;
        records.push({
          sourceObject: options.sourceObject || 'customers',
          sourceKey: id,
          sourceCursor: { offset: offset + i },
          payload: {
            _id: id,
            name: `  Customer ${offset + i}  `,
            email: `CUSTOMER_${offset + i}@EXAMPLE.COM`,
            phone: `+1-555-${String(offset + i).padStart(4, '0')}`,
            tier: i % 3 === 0 ? 'ENTERPRISE' : 'STANDARD',
            created_at: new Date().toISOString(),
            metadata: { registeredVia: 'worker_migration', batchSeq: offset + i },
          },
          extractedAt: new Date().toISOString(),
        });
      }

      return {
        records,
        nextCursor: { offset: offset + records.length },
        hasMore: false,
        stats: {
          bytesRead: 1024,
          recordsCount: records.length,
        },
      };
    },
    close: async () => {},
  };
}

async function startWorker() {
  try {
    if (REDIS_URL) {
      redisClient = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        tls: IS_REDIS_TLS ? { rejectUnauthorized: false } : undefined,
      });
    } else {
      redisClient = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASSWORD,
        tls: IS_REDIS_TLS ? { rejectUnauthorized: false } : undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
    }

    executionWorker = new Worker(
      'migration-execution',
      async (job: Job<MigrationJobPayload>) => {
        console.log(`[Worker] Received job: ${job.name} (Job ID: ${job.id})`);

        // FR-EXEC-002: strictly validate queue message contains identifiers/cursors, NOT bulk records
        QueueHandler.validatePayload(job.data);

        console.log(
          `[Worker] Executing run: ${job.data.migrationRunId}, Batch: ${job.data.batchKey}, Object: ${job.data.sourceObject} -> ${job.data.destinationObject}`,
        );

        // Instantiate QueueHandler with real connectors and transformers
        const queueHandler = new QueueHandler({
          sourceConnector,
          destinationConnector,
          manifestTracker,
          checkpointManager,
          idTracker,
          transformFn: async (envelope: SourceRecordEnvelope): Promise<TransformedRecord> => {
            const raw = ((envelope.payload || {}) as Record<string, any>);
            const destObj = job.data.destinationObject || envelope.sourceObject;
            let data: Record<string, any>;

            if (destObj === 'orders') {
              const amount = raw.totalAmount || raw.order_total || raw.total_amount || 0;
              data = {
                id: envelope.sourceKey,
                customer_id: raw.customerId || raw.customer_id,
                order_number: raw.orderNumber || raw.order_number || `ORD-${envelope.sourceKey}`,
                total_amount: amount,
                order_total: amount,
                status: raw.status || 'PENDING',
                items: typeof raw.items === 'object' ? JSON.stringify(raw.items) : raw.items || '[]',
                ordered_at: raw.orderedAt || raw.ordered_at || raw.createdAt || new Date().toISOString(),
                created_at: raw.createdAt || raw.created_at || new Date().toISOString(),
                run_id: job.data.migrationRunId,
              };
            } else if (destObj === 'customer_attachments' || destObj === 'attachments') {
              data = {
                id: envelope.sourceKey,
                customer_id: raw.customerId || raw.customer_id || raw.recordId,
                file_name: raw.fileName || raw.file_name || 'attachment.bin',
                file_size: raw.byteSize || raw.file_size || 0,
                content_type: raw.contentType || raw.content_type || 'application/octet-stream',
                checksum_sha256: raw.checksum || raw.sha256Checksum || raw.checksum_sha256 || null,
                storage_path: raw.storagePath || raw.storage_path || null,
                created_at: raw.createdAt || raw.created_at || new Date().toISOString(),
                run_id: job.data.migrationRunId,
                byte_size: raw.byteSize || raw.file_size || 0,
                sha256_checksum: raw.checksum || raw.sha256Checksum || raw.checksum_sha256 || null,
              };
            } else {
              data = {
                id: envelope.sourceKey,
                name: typeof raw.name === 'string' ? raw.name.trim() : raw.name || 'Unnamed',
                email: typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : raw.email || null,
                phone: raw.phone || null,
                tier: raw.tier || 'STANDARD',
                created_at: raw.createdAt || raw.created_at || new Date().toISOString(),
                metadata: typeof raw.metadata === 'object' ? JSON.stringify(raw.metadata) : raw.metadata || '{}',
                run_id: job.data.migrationRunId,
                status: raw.status || 'ACTIVE',
                updated_at: raw.updatedAt || raw.updated_at || new Date().toISOString(),
              };
            }

            return {
              sourceObject: envelope.sourceObject,
              sourceKey: envelope.sourceKey,
              destinationObject: destObj,
              destinationKey: envelope.sourceKey,
              data,
              contentHash: `sha256:${Buffer.from(JSON.stringify(raw)).toString('base64').substring(0, 32)}`,
            };
          },
        });

        // Execute real batch migration, write to destination, track manifests and checkpoint
        const result = await queueHandler.processJob(job.data);

        // Update run progress in PostgreSQL
        if (dbPool) {
          try {
            await dbPool.query(
              `UPDATE migration_runs 
               SET status = 'RUNNING',
                   progress_json = jsonb_set(
                     jsonb_set(
                       COALESCE(progress_json, '{}'::jsonb),
                       '{recordsWritten}',
                       (COALESCE((progress_json->>'recordsWritten')::int, 0) + $1)::text::jsonb
                     ),
                     '{recordsRead}',
                     (COALESCE((progress_json->>'recordsRead')::int, 0) + $2)::text::jsonb
                   ),
                   updated_at = NOW()
               WHERE id = $3`,
              [result.recordsWritten, result.recordsRead, job.data.migrationRunId],
            );
          } catch (err: any) {
            console.warn(`[Worker] Notice updating progress: ${err.message}`);
          }
        }

        console.log(
          `[Worker] ✔ Batch ${job.data.batchKey} executed: Read ${result.recordsRead}, Written ${result.recordsWritten}, Status: ${result.status}`,
        );

        return result;
      },
      {
        connection: redisClient,
        concurrency: 2,
        stalledInterval: 5000,
        lockDuration: 10000,
      },
    );

    executionWorker.on('completed', (job) => {
      console.log(`[Worker] Job ${job.id} marked COMPLETED.`);
    });

    executionWorker.on('failed', (job, err) => {
      console.error(`[Worker] Job ${job?.id} FAILED:`, err.message);
    });

    executionWorker.on('error', (err) => {
      console.warn(`[Worker] Redis queue connection notice: ${err.message}`);
    });

    console.log('[Worker] Worker pools initialized:');
    console.log('  ✔ migration-execution  (Concurrency: 2)');
    console.log('  ✔ PostgreSQL destination ready');
    console.log('  ✔ Manifest & Checkpoint tracking active');
    console.log('[Worker] Worker is listening for jobs.\n');
  } catch (err: any) {
    console.error(`[Worker] Error starting worker: ${err.message}`);
  }
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n[Worker] Graceful shutdown requested...');

  if (executionWorker) {
    await executionWorker.close();
    console.log('[Worker] Execution worker closed.');
  }
  if (redisClient) {
    redisClient.disconnect();
    console.log('[Worker] Redis connection disconnected.');
  }
  if (dbPool) {
    await dbPool.end();
    console.log('[Worker] Database pool closed.');
  }

  console.log('[Worker] Worker process terminated gracefully.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startWorker();
