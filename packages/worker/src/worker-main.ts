/**
 * MigrationGuard Data-Plane Worker Service
 * Specification Reference: 04_SYSTEM_ARCHITECTURE.md, 08_MIGRATION_ENGINE_DESIGN.md
 *
 * Standalone worker process for asynchronous migration execution, bounded-memory
 * batch streaming, idempotent writes, checkpointing, and real database writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
            if (process.env[k] === undefined) {
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

const isLoopbackHost = (host: string): boolean => {
  if (!host) return false;
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase().trim();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  );
};

const allowInsecureTls = process.env.ALLOW_INSECURE_TLS === 'true';
if (allowInsecureTls && process.env.NODE_ENV === 'production') {
  throw new Error('[Security] Insecure TLS (ALLOW_INSECURE_TLS=true) is strictly forbidden in production.');
}

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SYNTHETIC_SOURCE === 'true') {
  throw new Error('[Security] Synthetic source execution (ALLOW_SYNTHETIC_SOURCE=true) is strictly forbidden in production.');
}

const REDIS_URL = process.env.REDIS_URL;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const IS_REDIS_TLS =
  process.env.REDIS_TLS === 'true' ||
  REDIS_PORT === 15678 ||
  (REDIS_URL && REDIS_URL.startsWith('rediss://'));

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL;
  if (process.env.NODE_ENV === 'production') {
    if (!url || url.trim() === '') {
      throw new Error(
        '[Worker Config] In production (NODE_ENV=production), DATABASE_URL must be explicitly configured and cannot use localhost or loopback.',
      );
    }
    let hostname = '';
    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
    } catch (err: any) {
      throw new Error(`[Worker Config] In production (NODE_ENV=production), DATABASE_URL is invalid: ${err.message}`);
    }
    if (isLoopbackHost(hostname)) {
      throw new Error(
        `[Worker Config] In production (NODE_ENV=production), DATABASE_URL must be explicitly configured and cannot use localhost or loopback (${hostname}).`,
      );
    }
    return url;
  }
  return (
    url ||
    'postgresql://postgres:postgres_password@localhost:5432/migrationguard_control?schema=public'
  );
})();

if (process.env.NODE_ENV === 'production') {
  if (REDIS_URL) {
    let parsed: URL;
    try {
      parsed = new URL(REDIS_URL);
    } catch (err: any) {
      throw new Error(`[Worker Config] In production (NODE_ENV=production), REDIS_URL is invalid: ${err.message}`);
    }
    if (isLoopbackHost(parsed.hostname)) {
      throw new Error(
        `[Worker Config] In production (NODE_ENV=production), REDIS_URL cannot point to loopback/localhost (${parsed.hostname}).`,
      );
    }
    if (parsed.protocol !== 'rediss:') {
      throw new Error(
        `[Worker Config] In production (NODE_ENV=production), REDIS_URL must use TLS ('rediss://'). Got '${parsed.protocol}'.`,
      );
    }
  } else {
    if (!process.env.REDIS_HOST || isLoopbackHost(process.env.REDIS_HOST)) {
      throw new Error(
        `[Worker Config] In production (NODE_ENV=production), REDIS_URL or remote non-loopback REDIS_HOST must be explicitly configured.`,
      );
    }
    if (process.env.REDIS_TLS !== 'true') {
      throw new Error(
        `[Worker Config] In production (NODE_ENV=production), REDIS_TLS=true is required when connecting via REDIS_HOST.`,
      );
    }
  }
}

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
const isLocalDb = (() => {
  try {
    const parsed = new URL(DATABASE_URL);
    return isLoopbackHost(parsed.hostname);
  } catch {
    const match = /@([^:/]+|\[[^\]]+\])/.exec(DATABASE_URL);
    return match ? isLoopbackHost(match[1]) : false;
  }
})();

const isProduction = process.env.NODE_ENV === 'production';

dbPool = new pg.Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 10000,
  max: 20,
  ssl: isLocalDb && !isProduction ? false : { rejectUnauthorized: !allowInsecureTls },
});

const postgresAdapters = new PostgresStorageAdapters(dbPool);
const manifestTracker = new BatchManifestTracker(postgresAdapters);
const checkpointManager = new CheckpointManager(postgresAdapters);
const idTracker = new IdTracker(postgresAdapters);

// Initialize Destination Connector (PostgreSQL) — control-plane pool, used ONLY as fallback
// when no destinationConnectionId is provided in the job payload.
const defaultDestinationConnector: DestinationConnector =
  ConnectorFactory.createPostgresDestination(dbPool);

// Per-connection destination pool cache: keyed by "<connectionId>:v<credentialVersion>"
const destPoolCache = new Map<string, { pool: pg.Pool; connector: DestinationConnector }>();

// Default Source Connector (MongoDB if available, or synthetic fallback)
let defaultSourceConnector: SourceConnector;
const MONGO_URL = process.env.MONGO_URL || process.env.MONGODB_URI;
const MONGO_DB = process.env.MONGO_DB_NAME || 'migrationguard_e2e_source';

if (MONGO_URL && process.env.IGNORE_ENV_SOURCE_CONNECTOR !== 'true') {
  console.log(`[Worker] Source target: MongoDB (${MONGO_DB})`);
  defaultSourceConnector = ConnectorFactory.createMongoSource(MONGO_URL, MONGO_DB);
} else {
  console.log(`[Worker] Source target: Vault-driven resolution active (ENV fallback disabled)`);
  // Standalone source connector with in-memory sample records if MongoDB is not provided
  defaultSourceConnector = {
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

// Vault Credentials Resolution Cache
const sourceConnectorCache = new Map<string, SourceConnector>();
// destPoolCache is declared above near defaultDestinationConnector

/**
 * P0.2: Resolve the encryption key; throw (fail closed) if missing.
 * Never fall back to a hardcoded value.
 */
function resolveEncryptionKey(): Buffer {
  const rawKey = process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_MASTER_KEY;
  if (!rawKey || rawKey.trim() === '') {
    throw new Error(
      '[Worker] ENCRYPTION_KEY / ENCRYPTION_MASTER_KEY is not set. ' +
        'Worker cannot decrypt vault credentials. Set the environment variable and restart.',
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  // Non-hex key: derive 32 bytes via SHA-256 (supports short passphrases in dev)
  return crypto.createHash('sha256').update(rawKey).digest();
}

/**
 * P0.3: Resolves connection credentials from the PostgreSQL vault, pinned to the
 * exact credential_version recorded on the connection row (not "latest").
 */
async function resolveConnectionFromVault(connectionId: string): Promise<{
  engine: string;
  credentials: any;
  config: any;
  credentialVersion: number | null;
} | null> {
  if (!connectionId || !dbPool) return null;

  try {
    // Pin to c.credential_version — not ORDER BY version DESC
    const res = await dbPool.query(
      `SELECT c.engine, c.config_json, c.credential_version,
              s.encrypted_payload, s.iv, s.auth_tag, s.version AS secret_version
       FROM connections c
       LEFT JOIN connection_secrets s
         ON s.connection_id = c.id AND s.version = c.credential_version
       WHERE c.id = $1`,
      [connectionId],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    // If the pinned version has no vault record, that is a configuration error
    if (row.credential_version !== null && row.credential_version !== undefined && !row.encrypted_payload) {
      throw new Error(
        `[Worker] Vault record missing for connection ${connectionId} at pinned version ${row.credential_version}. ` +
          `Ensure connection_secrets contains a row for version ${row.credential_version}.`,
      );
    }

    if (!row.encrypted_payload) {
      return {
        engine: row.engine,
        credentials: null,
        config: typeof row.config_json === 'string' ? JSON.parse(row.config_json) : row.config_json || {},
        credentialVersion: row.credential_version ?? null,
      };
    }

    const key = resolveEncryptionKey();

    const iv = Buffer.from(row.iv, 'hex');
    const authTag = Buffer.from(row.auth_tag, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(row.encrypted_payload, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    const credentials = JSON.parse(decrypted);
    const config = typeof row.config_json === 'string' ? JSON.parse(row.config_json) : row.config_json || {};

    return {
      engine: row.engine,
      credentials,
      config,
      credentialVersion: row.credential_version ?? null,
    };
  } catch (err: any) {
    // Re-throw so callers can propagate job failure rather than silently falling back
    throw new Error(`[Worker] Vault resolution failed for connection ${connectionId}: ${err.message}`);
  }
}

async function getSourceConnector(payload: MigrationJobPayload): Promise<SourceConnector> {
  const connectionId = payload.sourceConnectionId;
  if (!connectionId) {
    if (process.env.ALLOW_SYNTHETIC_SOURCE === 'true') {
      console.warn(`[Worker] Using synthetic source connector fallback (ALLOW_SYNTHETIC_SOURCE=true).`);
      return defaultSourceConnector;
    }
    throw new Error(
      `[Worker] Missing sourceConnectionId in payload. Production migrations strictly require explicit Vault connection IDs.`,
    );
  }

  if (sourceConnectorCache.has(connectionId)) {
    return sourceConnectorCache.get(connectionId)!;
  }

  const vault = await resolveConnectionFromVault(connectionId);
  if (!vault || !vault.credentials) {
    throw new Error(
      `[Worker] Source connection ${connectionId} could not be resolved from Vault or has no credentials.`,
    );
  }

  const uri = vault.credentials.uri || vault.credentials.connectionString || vault.credentials.url;
  const dbName = vault.config?.database || process.env.MONGO_DB_NAME || 'migrationguard_e2e_source';

  if (!uri || (vault.engine !== 'MONGODB' && !uri.startsWith('mongodb'))) {
    throw new Error(
      `[Worker] Source connection ${connectionId} is not a valid MONGODB connection (engine=${vault.engine}).`,
    );
  }

  console.log(`[Worker] ✔ Dynamically resolved MongoDB source connector from Vault for connection ${connectionId} (database: ${dbName})`);
  const connector = ConnectorFactory.createMongoSource(uri, dbName);
  sourceConnectorCache.set(connectionId, connector);
  return connector;
}

/**
 * P0.1 & P0.4: Resolve the destination connector from the encrypted vault and create a
 * dedicated pg.Pool for that connection string. Never route a production migration to
 * defaultDestinationConnector / control-plane DATABASE_URL.
 *
 * Cache key: "<connectionId>:v<credentialVersion>" (P0.3 — version-pinned).
 */
async function getDestinationConnector(payload: MigrationJobPayload): Promise<DestinationConnector> {
  const connectionId = payload.destinationConnectionId;
  if (!connectionId) {
    throw new Error(
      `[Worker] Missing destinationConnectionId in payload. Writing to control-plane DATABASE_URL is strictly forbidden.`,
    );
  }

  const vault = await resolveConnectionFromVault(connectionId);
  if (!vault || !vault.credentials) {
    throw new Error(
      `[Worker] Destination vault resolution returned no credentials for connectionId ${connectionId}. ` +
        `Job cannot proceed without a verified destination connection string.`,
    );
  }

  const connStr = vault.credentials.connectionString || vault.credentials.uri || vault.credentials.url;
  if (!connStr || vault.engine !== 'POSTGRESQL') {
    throw new Error(
      `[Worker] Destination connection ${connectionId} is not a valid POSTGRESQL connection ` +
        `(engine=${vault.engine}, connStr=${connStr ? 'present' : 'missing'}).`,
    );
  }

  // P0.3: Cache key includes credential_version to handle rotation correctly
  const credVer = vault.credentialVersion ?? 'unpinned';
  const cacheKey = `${connectionId}:v${credVer}`;

  if (destPoolCache.has(cacheKey)) {
    console.log(`[Worker] ✔ Reusing cached destination pool for connection ${connectionId} v${credVer}`);
    return destPoolCache.get(cacheKey)!.connector;
  }

  console.log(`[Worker] ✔ Creating dedicated PostgreSQL destination pool for connection ${connectionId} v${credVer} (Strict TLS: ${!allowInsecureTls})`);
  const pool = new pg.Pool({
    connectionString: connStr,
    connectionTimeoutMillis: 10000,
    max: 10,
    ssl: { rejectUnauthorized: !allowInsecureTls },
  });

  const connector = ConnectorFactory.createPostgresDestination(pool);
  destPoolCache.set(cacheKey, { pool, connector });
  return connector;
}

async function startWorker() {
  try {
    const redisTls = IS_REDIS_TLS ? { rejectUnauthorized: !allowInsecureTls } : undefined;

    if (REDIS_URL) {
      redisClient = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        tls: redisTls,
      });
    } else {
      redisClient = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASSWORD,
        tls: redisTls,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
    }

    const QUEUE_NAME = process.env.BULLMQ_QUEUE_NAME || 'migration-execution';

    executionWorker = new Worker(
      QUEUE_NAME,
      async (job: Job<MigrationJobPayload>) => {
        console.log(`[Worker] Received job: ${job.name} (Job ID: ${job.id}) on queue '${QUEUE_NAME}'`);

        // FR-EXEC-002 & P0.4: strictly validate queue message contains identifiers/cursors, NOT bulk records
        // and requires explicit connection references in production
        QueueHandler.validatePayload(job.data, {
          requireConnections: process.env.ALLOW_SYNTHETIC_SOURCE !== 'true' || process.env.NODE_ENV === 'production',
        });

        console.log(
          `[Worker] Executing run: ${job.data.migrationRunId}, Batch: ${job.data.batchKey}, Object: ${job.data.sourceObject} -> ${job.data.destinationObject}`,
        );

        // Dynamically resolve connectors from connection vault in database
        const activeSourceConnector = await getSourceConnector(job.data);
        const activeDestinationConnector = await getDestinationConnector(job.data);

        // Instantiate QueueHandler with dynamic connectors and transformers
        const queueHandler = new QueueHandler({
          sourceConnector: activeSourceConnector,
          destinationConnector: activeDestinationConnector,
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

        // BullMQ Acknowledgement Semantics Constraint (P0 Issue #1):
        // Prevent BullMQ from acknowledging a job as COMPLETED when its manifest is uncommitted/failed.
        if (result.status !== 'COMMITTED') {
          const errDetail =
            result.error instanceof Error
              ? result.error.message
              : typeof result.error === 'string'
                ? result.error
                : `Batch ended in uncommitted status ${result.status}`;
          throw new Error(
            `Job failed for batch ${job.data.batchKey} (status: ${result.status}): ${errDetail}`,
          );
        }

        console.log(
          `[Worker] ✔ Batch ${job.data.batchKey} executed: Read ${result.recordsRead}, Written ${result.recordsWritten}, Status: ${result.status}`,
        );

        return result;
      },
      {
        connection: redisClient,
        concurrency: 2,
        stalledInterval: 3000,
        lockDuration: 8000,
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
    console.log(`  ✔ BullMQ Queue: '${QUEUE_NAME}' (Concurrency: 2)`);
    console.log('  ✔ PostgreSQL destination ready');
    console.log('  ✔ Manifest & Checkpoint tracking active');
    console.log('  ✔ Encrypted Vault credential resolution active');
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

  // P0.1: Close all per-connection destination pools
  for (const [cacheKey, entry] of destPoolCache.entries()) {
    try {
      await entry.pool.end();
      console.log(`[Worker] Destination pool closed: ${cacheKey}`);
    } catch (err: any) {
      console.warn(`[Worker] Error closing destination pool ${cacheKey}: ${err.message}`);
    }
  }
  destPoolCache.clear();

  if (dbPool) {
    await dbPool.end();
    console.log('[Worker] Control-plane database pool closed.');
  }

  console.log('[Worker] Worker process terminated gracefully.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startWorker();
