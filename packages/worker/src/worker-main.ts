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
import { Worker, Job, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { QueueHandler } from './engine/queue-handler.js';
import { BatchManifestTracker } from './engine/batch-manifest.js';
import { CheckpointManager } from './engine/checkpoint.js';
import { IdTracker } from './engine/id-tracker.js';
import { RecoveryEngine } from './engine/recovery-engine.js';
import { PostgresStorageAdapters } from './engine/postgres-storage-adapters.js';
import { calculateCanonicalHash, canonicalizeJson, TransformationEngine, ObjectMapping } from '@migrationguard/core';
import { ConnectorFactory, resolvePostgresSsl } from './connectors/connector-factory.js';
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

export function normalizeIpHost(host: string): string {
  if (!host) return '';
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase().trim();

  // Handle IPv4-mapped IPv6 in hex: e.g. ::ffff:7f00:1 or 0:0:0:0:0:ffff:7f00:1
  const ipv4MappedHex = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(clean);
  if (ipv4MappedHex) {
    const high = parseInt(ipv4MappedHex[1], 16);
    const low = parseInt(ipv4MappedHex[2], 16);
    const b1 = (high >> 8) & 0xff;
    const b2 = high & 0xff;
    const b3 = (low >> 8) & 0xff;
    const b4 = low & 0xff;
    return `${b1}.${b2}.${b3}.${b4}`;
  }

  // Handle IPv4-mapped IPv6 in dotted decimal: ::ffff:127.0.0.1
  const ipv4MappedDot = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(clean);
  if (ipv4MappedDot) {
    return ipv4MappedDot[1];
  }

  // Handle fully expanded IPv6 loopback and unspecified
  if (/^(0+:){7}0*1$/.test(clean)) {
    return '::1';
  }
  if (/^(0+:){7}0*0$/.test(clean)) {
    return '::';
  }

  return clean;
}

export const isLoopbackHost = (host: string): boolean => {
  if (!host) return false;
  const normalized = normalizeIpHost(host);
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  );
};

export const isUnspecifiedHost = (host: string): boolean => {
  if (!host) return false;
  const normalized = normalizeIpHost(host);
  return normalized === '0.0.0.0' || normalized === '::';
};

export const isUnsafeProductionHost = (host: string): boolean => {
  return isLoopbackHost(host) || isUnspecifiedHost(host);
};

export function validateDestinationConnectionString(connStr: string, connectionId = 'unknown'): void {
  if (!connStr || connStr.trim() === '') {
    throw new Error(`[Worker Security] Destination connection ${connectionId} has an empty connection string.`);
  }

  let hostname = '';
  try {
    const parsed = new URL(connStr);
    hostname = parsed.hostname;
  } catch {
    const match = /@(?:\[([^\]]+)\]|([^/@]+?)(?::\d+)?(?:\/|$))/.exec(connStr);
    if (match) {
      hostname = match[1] || match[2];
    } else {
      throw new Error(`[Worker Security] Destination connection ${connectionId} has an invalid connection string format.`);
    }
  }

  if (process.env.NODE_ENV === 'production' && isUnsafeProductionHost(hostname)) {
    throw new Error(
      `[Worker Security] In production (NODE_ENV=production), destination connection ${connectionId} cannot point to localhost, loopback, or wildcard addresses (${hostname}).`,
    );
  }
}

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
    if (isUnsafeProductionHost(hostname)) {
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
    if (isUnsafeProductionHost(parsed.hostname)) {
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
    if (!process.env.REDIS_HOST || isUnsafeProductionHost(process.env.REDIS_HOST)) {
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
let executionQueue: Queue<MigrationJobPayload> | null = null;
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

function validateSafeSchemaIdentifier(rawSchema?: string): string | undefined {
  if (!rawSchema) return undefined;
  const clean = rawSchema.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(clean)) {
    throw new Error(`[Worker Config] Invalid PostgreSQL schema identifier: '${rawSchema}'.`);
  }
  return clean;
}

const POSTGRES_SCHEMA = validateSafeSchemaIdentifier(process.env.POSTGRES_SCHEMA);

dbPool = new pg.Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 10000,
  max: 20,
  ssl: resolvePostgresSsl(DATABASE_URL),
  ...(POSTGRES_SCHEMA ? { options: `-c search_path="${POSTGRES_SCHEMA}"` } : {}),
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
const sourceConnectorCache = new Map<string, { connector: SourceConnector; connectionId: string; credVer: string | number }>();
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

  const vault = await resolveConnectionFromVault(connectionId);
  if (!vault || !vault.credentials) {
    throw new Error(
      `[Worker] Source connection ${connectionId} could not be resolved from Vault or has no credentials.`,
    );
  }

  const credVer = vault.credentialVersion ?? 'unpinned';
  const cacheKey = `${connectionId}:v${credVer}`;

  if (sourceConnectorCache.has(cacheKey)) {
    return sourceConnectorCache.get(cacheKey)!.connector;
  }

  // Recreate and close stale connectors after credential rotation
  for (const [key, entry] of sourceConnectorCache.entries()) {
    if (entry.connectionId === connectionId && key !== cacheKey) {
      console.log(`[Worker] Credential rotation detected for source connection ${connectionId}. Closing stale connector ${key}`);
      try {
        if ('close' in entry.connector && typeof (entry.connector as any).close === 'function') {
          await (entry.connector as any).close();
        }
      } catch (err: any) {
        console.warn(`[Worker] Failed closing stale source connector ${key}: ${err.message}`);
      }
      sourceConnectorCache.delete(key);
    }
  }

  const uri = vault.credentials.uri || vault.credentials.connectionString || vault.credentials.url;
  let dbName = vault.config?.database || vault.credentials?.database;
  if (!dbName && uri) {
    try {
      const parsed = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
      const pathname = parsed.pathname.replace(/^\//, '');
      if (pathname) {
        dbName = pathname;
      }
    } catch {}
  }

  if (!dbName) {
    if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
      throw new Error(`[Worker] Source connection ${connectionId} missing explicit database name in vault config or URI.`);
    }
    dbName = process.env.MONGO_DB_NAME || 'migrationguard_e2e_source';
  }

  if (!uri || (vault.engine !== 'MONGODB' && !uri.startsWith('mongodb'))) {
    throw new Error(
      `[Worker] Source connection ${connectionId} is not a valid MONGODB connection (engine=${vault.engine}).`,
    );
  }

  console.log(`[Worker] ✔ Dynamically resolved MongoDB source connector from Vault for connection ${connectionId} v${credVer} (database: ${dbName})`);
  const connector = ConnectorFactory.createMongoSource(uri, dbName);
  sourceConnectorCache.set(cacheKey, { connector, connectionId, credVer });
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

  // Runtime Destination Safety Enforcement: Validate connection string against unsafe production hosts
  validateDestinationConnectionString(connStr, connectionId);

  // P0.3: Cache key includes credential_version to handle rotation correctly
  const credVer = vault.credentialVersion ?? 'unpinned';
  const cacheKey = `${connectionId}:v${credVer}`;

  if (destPoolCache.has(cacheKey)) {
    console.log(`[Worker] ✔ Reusing cached destination pool for connection ${connectionId} v${credVer}`);
    return destPoolCache.get(cacheKey)!.connector;
  }

  // Recreate and close stale destination pools after credential rotation
  for (const [key, entry] of destPoolCache.entries()) {
    if (key.startsWith(`${connectionId}:`) && key !== cacheKey) {
      console.log(`[Worker] Credential rotation detected for destination connection ${connectionId}. Closing stale pool ${key}`);
      try {
        await entry.pool.end();
      } catch (err: any) {
        console.warn(`[Worker] Failed closing stale destination pool ${key}: ${err.message}`);
      }
      destPoolCache.delete(key);
    }
  }

  console.log(`[Worker] ✔ Creating dedicated PostgreSQL destination pool for connection ${connectionId} v${credVer}`);
  const destSchema = validateSafeSchemaIdentifier(vault.config?.schema || process.env.POSTGRES_SCHEMA);
  const pool = new pg.Pool({
    connectionString: connStr,
    connectionTimeoutMillis: 10000,
    max: 10,
    ssl: resolvePostgresSsl(connStr),
    ...(destSchema ? { options: `-c search_path="${destSchema}"` } : {}),
  });

  const connector = ConnectorFactory.createPostgresDestination(pool);
  destPoolCache.set(cacheKey, { pool, connector });
  return connector;
}

/**
 * Priority 2: Reconcile in-flight/ambiguous runs and batches on worker startup/restart.
 * Inspects PostgreSQL for batches or runs interrupted mid-flight (e.g. process crash, OOM, reboot).
 * Calls RecoveryEngine.prepareResume() to verify destination records and advance checkpoints.
 * Never silently swallows recovery failures: if recovery cannot complete safely, throws error to halt worker startup.
 */
/**
 * Recomputes migration run progress and status from all batches in a concurrency-safe manner.
 * Guarantees that a migration is NEVER marked COMPLETED while any batch is in RETRY_WAIT or non-terminal.
 * Allows retry success to update a previously failed run to COMPLETED.
 */
async function recomputeMigrationRunProgress(runId: string): Promise<void> {
  if (!dbPool) return;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // Finding 3: Serialized run-status recomputation using transactional advisory lock and row-level lock
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('migration_run_status_' || $1))`, [runId]);
    const runLockRes = await client.query(
      `SELECT id, status FROM migration_runs WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    if (runLockRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }
    const currentRunStatus = runLockRes.rows[0].status;

    const totalsRes = await client.query(
      `SELECT COALESCE(SUM(records_written), 0) AS total_written,
              COALESCE(SUM(records_read), 0) AS total_read
       FROM migration_batches
       WHERE migration_run_id = $1`,
      [runId],
    );
    const totalWritten = Number(totalsRes.rows[0]?.total_written || 0);
    const totalRead = Number(totalsRes.rows[0]?.total_read || 0);

    // Concurrency-safe progress update
    await client.query(
      `UPDATE migration_runs 
       SET progress_json = jsonb_set(
             jsonb_set(
               COALESCE(progress_json, '{}'::jsonb),
               '{recordsWritten}',
               $1::text::jsonb
             ),
             '{recordsRead}',
             $2::text::jsonb
           ),
           updated_at = NOW()
       WHERE id = $3 AND status NOT IN ('PAUSED', 'CANCELLED')`,
      [totalWritten, totalRead, runId],
    );

    // Recompute migration status from all batches before finalizing
    const statusCountsRes = await client.query(
      `SELECT status, COUNT(*)::int AS count
       FROM migration_batches
       WHERE migration_run_id = $1
       GROUP BY status`,
      [runId],
    );

    const counts = new Map<string, number>();
    let totalBatches = 0;
    for (const r of statusCountsRes.rows) {
      counts.set(r.status, Number(r.count));
      totalBatches += Number(r.count);
    }

    if (totalBatches > 0) {
      const nonTerminalCount =
        (counts.get('PENDING') || 0) +
        (counts.get('QUEUED') || 0) +
        (counts.get('RUNNING') || 0) +
        (counts.get('RETRY_WAIT') || 0);

      if (nonTerminalCount > 0) {
        // Never mark a migration COMPLETED while any batch is in RETRY_WAIT or another non-terminal state.
        // If a migration was previously marked terminal FAILED but now has a retry in flight, update back to RUNNING.
        // Crucially, never regress a COMPLETED run back to RUNNING if racing workers see a non-terminal batch.
        await client.query(
          `UPDATE migration_runs
           SET status = 'RUNNING', completed_at = NULL, updated_at = NOW()
           WHERE id = $1 AND status NOT IN ('PAUSED', 'CANCELLED', 'RUNNING', 'COMPLETED') AND status = 'FAILED'`,
          [runId],
        );
      } else {
        // All batches are in terminal states: COMMITTED, FAILED_PERMANENT, FAILED_RETRYABLE, OUTCOME_UNKNOWN
        const failedCount =
          (counts.get('FAILED_PERMANENT') || 0) +
          (counts.get('FAILED_RETRYABLE') || 0) +
          (counts.get('OUTCOME_UNKNOWN') || 0);

        const committedCount = counts.get('COMMITTED') || 0;

        if (failedCount === 0 && committedCount === totalBatches) {
          // All batches COMMITTED! Mark run COMPLETED (even if it was previously marked terminal FAILED)
          await client.query(
            `UPDATE migration_runs
             SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND status NOT IN ('PAUSED', 'CANCELLED', 'COMPLETED')`,
            [runId],
          );
          console.log(`[Worker] Migration run ${runId} finalized with status: COMPLETED`);
        } else if (failedCount > 0) {
          // Terminal failure
          await client.query(
            `UPDATE migration_runs
             SET status = 'FAILED', completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND status NOT IN ('PAUSED', 'CANCELLED', 'FAILED')`,
            [runId],
          );
          console.log(`[Worker] Migration run ${runId} finalized with status: FAILED (${failedCount} failed batch(es))`);
        }
      }
    }
    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[Worker] Error during recomputeMigrationRunProgress for run ${runId}: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function reconcileStrandedRunsOnStartup(): Promise<void> {
  if (!dbPool) return;
  try {
    const candidateRuns = await dbPool.query(
      `SELECT DISTINCT mr.id, mr.status, mr.plan_version_id
       FROM migration_runs mr
       JOIN migration_batches mb ON mb.migration_run_id = mr.id
       WHERE mr.status = 'RUNNING'
          OR mb.status IN ('RUNNING', 'OUTCOME_UNKNOWN', 'RETRY_WAIT')`,
    );

    if (candidateRuns.rows.length === 0) {
      console.log('[Worker Recovery] No stranded or in-flight migration runs found on startup.');
      return;
    }

    console.log(`[Worker Recovery] Found ${candidateRuns.rows.length} candidate run(s) for startup reconciliation.`);

    for (const row of candidateRuns.rows) {
      const runId = row.id;
      const objectsRes = await dbPool.query(
        `SELECT DISTINCT source_object, destination_object,
                source_connection_id, destination_connection_id, destination_key, plan_version_id, mapping_version_id
         FROM migration_batches
         WHERE migration_run_id = $1`,
        [runId],
      );

      const isStrict = process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false';
      const effectivePlanVersionId = row.plan_version_id || objectsRes.rows[0]?.plan_version_id;
      if (!effectivePlanVersionId && isStrict) {
        throw new Error(`[Worker Recovery] Missing plan_version_id for stranded run ${runId}. Startup recovery failed closed.`);
      }

      let planRow: any = null;
      let objects: any[] = [];

      if (effectivePlanVersionId) {
        const planRes = await dbPool.query(
          `SELECT mpv.id as plan_version_id,
                  mpv.destination_connection_id,
                  mpv.source_connection_id,
                  mpv.mapping_version_id,
                  mpv.scope_json,
                  mpv.execution_config_json,
                  mv.mapping_json
           FROM migration_plan_versions mpv
           LEFT JOIN mapping_versions mv ON mv.id = mpv.mapping_version_id
           WHERE mpv.id = $1`,
          [effectivePlanVersionId],
        );
        if (planRes.rows.length === 0) {
          throw new Error(`[Worker Recovery] Plan version ${effectivePlanVersionId} not found for stranded run ${runId}`);
        }

        planRow = planRes.rows[0];

        const mappingJson = typeof planRow.mapping_json === 'string'
          ? JSON.parse(planRow.mapping_json)
          : planRow.mapping_json || {};
        objects = Array.isArray(mappingJson.objects)
          ? mappingJson.objects
          : (mappingJson.source ? [mappingJson] : []);

        if (objects.length === 0 && isStrict) {
          throw new Error(`[Worker Recovery] No mapped objects found on plan version ${effectivePlanVersionId} for stranded run ${runId}. Startup recovery failed closed.`);
        }
      }

      // Resolve each object's destination connector, mapping, and identity key independently.
      // Fail closed when plan version, mapping, destination connector, or identity key is missing or ambiguous.
      for (const objRow of objectsRes.rows) {
        if ((!objRow.source_object || !objRow.destination_object) && isStrict) {
          throw new Error(`[Worker Recovery] Ambiguous or missing source/destination object in batch for run ${runId}. Startup recovery failed closed.`);
        }
        const srcObj = objRow.source_object || 'customers';
        const dstObj = objRow.destination_object || 'customers';

        let objDestConnector = defaultDestinationConnector;
        let objDestKey: string | null = objRow.destination_key || null;

        if (planRow) {
          const exactMatches = objects.filter(
            (o: any) =>
              ((o.destination?.table || o.destination?.object || o.destination) === dstObj) &&
              ((o.source?.collection || o.source?.object || o.source) === srcObj),
          );

          if (exactMatches.length > 1 && isStrict) {
            throw new Error(`[Worker Recovery] Ambiguous mapping: multiple objects match '${srcObj}' -> '${dstObj}' in run ${runId}. Startup recovery failed closed.`);
          }

          // Exact matching only: NO single-mapping fallback!
          const matched = exactMatches.length === 1 ? exactMatches[0] : null;

          if (!matched && isStrict) {
            throw new Error(`[Worker Recovery] No matching object mapping found for '${srcObj}' -> '${dstObj}' in plan version ${effectivePlanVersionId} for run ${runId}. Startup recovery failed closed.`);
          }

          if (!objDestKey) {
            if (matched?.identity?.destinationKey || matched?.destination?.key || matched?.destination?.identityKey) {
              objDestKey = matched.identity?.destinationKey || matched.destination?.key || matched.destination?.identityKey;
            } else if (planRow.execution_config_json?.conflictColumns?.[0]) {
              objDestKey = planRow.execution_config_json.conflictColumns[0];
            }
          }

          const objDestConnId = objRow.destination_connection_id || matched?.destinationConnectionId || matched?.destination?.connectionId || planRow.destination_connection_id;
          if (!objDestConnId && isStrict) {
            throw new Error(`[Worker Recovery] No destination connection configured for object '${dstObj}' in run ${runId}. Refusing control-plane fallback in production.`);
          }

          if (objDestConnId) {
            objDestConnector = await getDestinationConnector({ destinationConnectionId: objDestConnId } as any);
            if (!objDestConnector) {
              throw new Error(`[Worker Recovery] Failed to resolve destination connector for connection ${objDestConnId} in run ${runId} for object ${dstObj}`);
            }
          } else if (isStrict) {
            throw new Error(`[Worker Recovery] Missing destination connector for object '${dstObj}' in run ${runId}. Refusing control-plane fallback in production.`);
          }
        } else if (isStrict) {
          throw new Error(`[Worker Recovery] Plan row missing for run ${runId}. Refusing control-plane fallback in production.`);
        }

        if (!objDestKey) {
          if (isStrict) {
            throw new Error(`[Worker Recovery] Missing destination identity key for object '${dstObj}' in run ${runId}. Refusing default 'id' fallback in production.`);
          }
          objDestKey = 'id';
        }

        const recoveryEngine = new RecoveryEngine({
          destinationConnector: objDestConnector,
          manifestTracker,
          checkpointManager,
          idTracker,
          dbPool: dbPool || undefined,
        });

        const resumePlan = await recoveryEngine.prepareResume(
          runId,
          srcObj,
          dstObj,
          objDestKey,
          effectivePlanVersionId,
          planRow?.mapping_version_id,
        );

        console.log(
          `[Worker Recovery] Startup resume prepared for run ${runId} (${srcObj} -> ${dstObj}) with identity key '${objDestKey}': ` +
          `checkpoint seq ${resumePlan.lastCommittedSequenceNo}, ` +
          `reconciled ${resumePlan.reconciledBatches.length} batch(es)`,
        );
      }
    }
  } catch (err: any) {
    console.error(`[Worker Recovery] Fatal error during startup reconciliation: ${err.message}`);
    throw err;
  }
}

async function startWorker() {
  try {
    // 1. Verify control-plane database connectivity and reconcile stranded runs on startup/restart
    if (dbPool) {
      try {
        await dbPool.query('SELECT 1');
      } catch (dbErr: any) {
        throw new Error(`Control-plane PostgreSQL connection failed: ${dbErr.message}`);
      }

      // Reconcile any in-flight/ambiguous runs from worker restarts or crashes
      await reconcileStrandedRunsOnStartup();
    }

    const redisTls = IS_REDIS_TLS ? { rejectUnauthorized: !allowInsecureTls } : undefined;

    const redisOptions = {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectTimeout: 3000,
      retryStrategy: (times: number) => {
        if (process.env.NODE_ENV === 'test' && times > 2) {
          return null; // Terminate retries quickly in test environment
        }
        if (times > 5) {
          return null;
        }
        return Math.min(times * 100, 1000);
      },
      tls: redisTls,
    };

    if (REDIS_URL) {
      redisClient = new Redis(REDIS_URL, redisOptions);
    } else {
      redisClient = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASSWORD,
        ...redisOptions,
      });
    }

    redisClient.on('error', (err) => {
      // Prevent unhandled error event during initial connection failure or reconnects
    });

    // Verify Redis connection via ping
    try {
      await redisClient.ping();
    } catch (redisErr: any) {
      throw new Error(`Redis connection failed: ${redisErr.message}`);
    }

    const QUEUE_NAME = process.env.BULLMQ_QUEUE_NAME || 'migration-execution';
    const BULLMQ_PREFIX = process.env.BULLMQ_PREFIX;

    // Initialize execution queue for scheduling subsequent batches
    executionQueue = new Queue(QUEUE_NAME, {
      connection: redisClient,
      ...(BULLMQ_PREFIX ? { prefix: BULLMQ_PREFIX } : {}),
    });

    executionWorker = new Worker(
      QUEUE_NAME,
      async (job: Job<MigrationJobPayload>) => {
        console.log(`[Worker] Received job: ${job.name} (Job ID: ${job.id}) on queue '${QUEUE_NAME}'`);

        // FR-EXEC-002 & P0.4: strictly validate queue message contains identifiers/cursors, NOT bulk records
        // and requires explicit connection references in production
        QueueHandler.validatePayload(job.data, {
          requireConnections: process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false',
        });

        console.log(
          `[Worker] Executing run: ${job.data.migrationRunId}, Batch: ${job.data.batchKey}, Object: ${job.data.sourceObject} -> ${job.data.destinationObject}`,
        );

        // Check if migration run is paused or cancelled before doing any work
        if (dbPool) {
          const runCheck = await dbPool.query(
            `SELECT status FROM migration_runs WHERE id = $1`,
            [job.data.migrationRunId],
          );
          if (runCheck.rows.length > 0) {
            const currentStatus = runCheck.rows[0].status;
            if (currentStatus === 'PAUSED' || currentStatus === 'CANCELLED') {
              console.log(`[Worker] Run ${job.data.migrationRunId} is ${currentStatus}. Halting execution of batch ${job.data.batchKey}.`);
              if (currentStatus === 'PAUSED') {
                await dbPool.query(
                  `UPDATE migration_batches SET status = 'PAUSED' WHERE migration_run_id = $1 AND batch_key = $2`,
                  [job.data.migrationRunId, job.data.batchKey],
                );
                throw new Error(`[Worker] Execution paused for run ${job.data.migrationRunId}. Batch ${job.data.batchKey} marked PAUSED.`);
              }
              await dbPool.query(
                `UPDATE migration_batches SET status = 'CANCELLED' WHERE migration_run_id = $1 AND batch_key = $2`,
                [job.data.migrationRunId, job.data.batchKey],
              );
              return {
                migrationRunId: job.data.migrationRunId,
                batchKey: job.data.batchKey,
                sequenceNo: job.data.sequenceNo,
                status: 'FAILED_PERMANENT',
                recordsRead: 0,
                recordsWritten: 0,
                recordsSkipped: 0,
                recordsFailed: 0,
                hasMore: false,
              };
            }
          }
        }

        // Dynamically resolve connectors from connection vault in database
        const activeSourceConnector = await getSourceConnector(job.data);
        const activeDestinationConnector = await getDestinationConnector(job.data);

        // Recovery Engine integration: check for incomplete/ambiguous previous batch outcomes
        const recoveryEngine = new RecoveryEngine({
          destinationConnector: activeDestinationConnector,
          manifestTracker,
          checkpointManager,
          idTracker,
          dbPool: dbPool || undefined,
        });

        const destKey = job.data.destinationKey || (job.data.conflictColumns && job.data.conflictColumns.length > 0 ? job.data.conflictColumns[0] : 'id');

        const existingBatch = await manifestTracker.getBatch(job.data.migrationRunId, job.data.batchKey);
        if (existingBatch) {
          if (existingBatch.status === 'COMMITTED') {
            console.log(`[Worker] ✔ Batch ${job.data.batchKey} was already committed. Recomputing parent run progress idempotently.`);
            await recomputeMigrationRunProgress(job.data.migrationRunId);
            return {
              migrationRunId: job.data.migrationRunId,
              batchKey: job.data.batchKey,
              sequenceNo: job.data.sequenceNo,
              status: 'COMMITTED',
              recordsRead: existingBatch.recordsRead,
              recordsWritten: existingBatch.recordsWritten,
              recordsSkipped: existingBatch.recordsSkipped,
              recordsFailed: existingBatch.recordsFailed,
              hasMore: false,
            };
          }

          if (
            existingBatch.status === 'OUTCOME_UNKNOWN' ||
            existingBatch.status === 'RUNNING' ||
            existingBatch.subStage === 'WRITE_STARTED' ||
            existingBatch.subStage === 'DESTINATION_WRITTEN' ||
            existingBatch.subStage === 'MANIFEST_COMMITTED'
          ) {
            console.log(
              `[Worker] Detected uncommitted/in-flight batch ${job.data.batchKey} (status: ${existingBatch.status}, subStage: ${existingBatch.subStage}). Reconciling via RecoveryEngine.`,
            );
            const reconciled = await recoveryEngine.reconcileBatch(
              existingBatch,
              job.data.destinationObject,
              destKey,
              job.data.planVersionId,
              job.data.mappingVersionId,
            );
            if (reconciled && reconciled.resolvedStatus === 'COMMITTED') {
              console.log(`[Worker] ✔ Reconciled and committed batch ${job.data.batchKey} via RecoveryEngine.`);
              await recomputeMigrationRunProgress(job.data.migrationRunId);
              const updatedBatch = await manifestTracker.getBatch(job.data.migrationRunId, job.data.batchKey);
              return {
                migrationRunId: job.data.migrationRunId,
                batchKey: job.data.batchKey,
                sequenceNo: job.data.sequenceNo,
                status: 'COMMITTED',
                recordsRead: updatedBatch?.recordsRead || existingBatch.recordsRead,
                recordsWritten: updatedBatch?.recordsWritten || existingBatch.recordsWritten,
                recordsSkipped: updatedBatch?.recordsSkipped || existingBatch.recordsSkipped,
                recordsFailed: updatedBatch?.recordsFailed || existingBatch.recordsFailed,
                hasMore: false,
              };
            }
            if (reconciled && reconciled.resolvedStatus === 'OUTCOME_UNKNOWN') {
              throw new Error(
                `[Worker] Batch ${job.data.batchKey} ended in OUTCOME_UNKNOWN: destination records could not be verified.`,
              );
            }
          }
        }

        // In production, strictly prohibit ALLOW_DEMO_MAPPING
        if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_MAPPING === 'true') {
          throw new Error('[Worker Security] CRITICAL: ALLOW_DEMO_MAPPING=true is strictly prohibited in production.');
        }

        // Load mapping version and instantiate TransformationEngine if available
        let transformationEngine: TransformationEngine | null = null;
        let mappedDestinationFields: string[] | undefined = undefined;
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.data.mappingVersionId || '');
        if (job.data.mappingVersionId && dbPool && isUuid) {
          const mapRes = await dbPool.query(
            `SELECT mv.mapping_json, mv.mapping_hash, mv.workspace_id, mp.workspace_id as plan_workspace_id
             FROM mapping_versions mv
             LEFT JOIN migration_plans mp ON mp.id = (
               SELECT plan_id FROM migration_plan_versions WHERE id = $2
             )
             WHERE mv.id = $1`,
            [job.data.mappingVersionId, job.data.planVersionId || null],
          );
          if (mapRes.rows.length === 0) {
            throw new Error(`[Worker Security] Mapping version ${job.data.mappingVersionId} not found in database. Fails closed.`);
          }

          const mappingRow = mapRes.rows[0];
          if (mappingRow.plan_workspace_id && mappingRow.workspace_id && mappingRow.plan_workspace_id !== mappingRow.workspace_id) {
            throw new Error(`[Worker Security] Cross-tenant mapping reference detected: mapping workspace does not match plan workspace.`);
          }

          const mappingJson =
            typeof mappingRow.mapping_json === 'string'
              ? JSON.parse(mappingRow.mapping_json)
              : mappingRow.mapping_json;

          // Verify mapping hash
          const rawHash = mappingRow.mapping_hash;
          if (rawHash) {
            const computedHash = 'sha256:' + crypto.createHash('sha256').update(canonicalizeJson(mappingJson)).digest('hex');
            const simpleHash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(mappingJson)).digest('hex');
            if (rawHash !== computedHash && rawHash !== simpleHash) {
              throw new Error(`[Worker Security] Approved mapping hash verification failed: content mismatch for ${job.data.mappingVersionId}.`);
            }
          }

          // Exact source AND destination match required; fail closed on ambiguous or missing mapping
          let matchedMapping: ObjectMapping | null = null;
          if (Array.isArray(mappingJson.objects)) {
            const matches = mappingJson.objects.filter(
              (o: any) =>
                (o.source?.collection || o.source?.object || o.sourceObject || o.source) === job.data.sourceObject &&
                (o.destination?.table || o.destination?.object || o.destinationObject || o.destination) === job.data.destinationObject,
            );
            if (matches.length > 1) {
              throw new Error(
                `[Worker Security] Ambiguous mapping: multiple approved objects match source '${job.data.sourceObject}' and destination '${job.data.destinationObject}'. Fails closed.`,
              );
            }
            matchedMapping = matches.length === 1 ? matches[0] : null;
            if (matchedMapping && Array.isArray((matchedMapping as any).fields)) {
              mappedDestinationFields = (matchedMapping as any).fields
                .map((f: any) => f.destinationField || f.destination || f.destField)
                .filter(Boolean);
            }
          } else if (mappingJson.source && mappingJson.destination) {
            const sMatch = (mappingJson.source?.collection || mappingJson.source?.object || mappingJson.sourceObject || mappingJson.source) === job.data.sourceObject;
            const dMatch = (mappingJson.destination?.table || mappingJson.destination?.object || mappingJson.destinationObject || mappingJson.destination) === job.data.destinationObject;
            if (sMatch && dMatch) {
              matchedMapping = mappingJson as ObjectMapping;
              if (matchedMapping && Array.isArray((matchedMapping as any).fields)) {
                mappedDestinationFields = (matchedMapping as any).fields
                  .map((f: any) => f.destinationField || f.destination || f.destField)
                  .filter(Boolean);
              }
            }
          }

          if (!matchedMapping) {
            throw new Error(
              `[Worker Security] No approved mapping object found matching source '${job.data.sourceObject}' and destination '${job.data.destinationObject}'. Fails closed.`,
            );
          }

          transformationEngine = new TransformationEngine(matchedMapping);
        } else if (process.env.NODE_ENV === 'production') {
          throw new Error(`[Worker Security] Valid approved UUID mappingVersionId is strictly required in production.`);
        }

        // Instantiate QueueHandler with dynamic connectors, recovery, and streaming scheduler
        const queueHandler = new QueueHandler({
          sourceConnector: activeSourceConnector,
          destinationConnector: activeDestinationConnector,
          manifestTracker,
          checkpointManager,
          idTracker,
          transformFn: async (envelope: SourceRecordEnvelope): Promise<TransformedRecord> => {
            const raw = (envelope.payload || {}) as Record<string, any>;
            const destObj = job.data.destinationObject || envelope.sourceObject;

            // Preserve original source ID for the destination business ID (decoupled from internal typed keys)
            const businessId = raw._id !== undefined && raw._id !== null
              ? (typeof raw._id === 'object' && raw._id.toString ? raw._id.toString() : String(raw._id))
              : (raw.id !== undefined && raw.id !== null
                  ? String(raw.id)
                  : (envelope.sourceKey.includes(':')
                      ? envelope.sourceKey.substring(envelope.sourceKey.indexOf(':') + 1)
                      : envelope.sourceKey));

            // Execute real mapping DSL via TransformationEngine when available
            if (transformationEngine) {
              const transformed = transformationEngine.transform(envelope as any);
              return {
                destinationKey: transformed.destinationKey,
                sourceKey: transformed.sourceKey,
                sourceObject: transformed.sourceObject,
                destinationObject: transformed.destinationObject,
                data: transformed.payload,
                contentHash: transformed.canonicalHash || calculateCanonicalHash(transformed.payload),
              };
            }

            if (!transformationEngine && process.env.NODE_ENV === 'production') {
              throw new Error(
                `[Worker Security] Production execution strictly requires an approved mapping version for ${envelope.sourceObject} -> ${destObj}.`,
              );
            }

            let data: Record<string, any>;

            if (destObj === 'orders') {
              const amount = raw.totalAmount || raw.order_total || raw.total_amount || 0;
              data = {
                id: businessId,
                customer_id: raw.customerId || raw.customer_id,
                order_number: raw.orderNumber || raw.order_number || `ORD-${businessId}`,
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
                id: businessId,
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
                id: businessId,
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

            if (!job.data.destinationKey && (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false')) {
              throw new Error(`[Worker Security] Missing destinationKey in payload for batch ${job.data.batchKey}. Prohibiting implicit default 'id' in production.`);
            }
            const effectiveDestKeyCol = job.data.destinationKey || 'id';
            const recordDestKey = String(raw[effectiveDestKeyCol] !== undefined ? raw[effectiveDestKeyCol] : businessId);

            return {
              sourceObject: envelope.sourceObject,
              sourceKey: envelope.sourceKey,
              destinationObject: destObj,
              destinationKey: recordDestKey,
              data,
              contentHash: calculateCanonicalHash(data),
            };
          },
          onNextBatchScheduled: process.env.ENABLE_WORKER_AUTO_STREAMING === 'true'
            ? async (nextPayload: MigrationJobPayload) => {
                // Ensure complete immutable metadata is preserved on the streaming payload
                if (!nextPayload.destinationKey && job.data.destinationKey) {
                  nextPayload.destinationKey = job.data.destinationKey;
                }
                if (!nextPayload.sourceObject && job.data.sourceObject) {
                  nextPayload.sourceObject = job.data.sourceObject;
                }
                if (!nextPayload.destinationObject && job.data.destinationObject) {
                  nextPayload.destinationObject = job.data.destinationObject;
                }
                if (!nextPayload.mappingVersionId && job.data.mappingVersionId) {
                  nextPayload.mappingVersionId = job.data.mappingVersionId;
                }
                if (!nextPayload.planVersionId && job.data.planVersionId) {
                  nextPayload.planVersionId = job.data.planVersionId;
                }
                if (!nextPayload.sourceConnectionId && job.data.sourceConnectionId) {
                  nextPayload.sourceConnectionId = job.data.sourceConnectionId;
                }
                if (!nextPayload.destinationConnectionId && job.data.destinationConnectionId) {
                  nextPayload.destinationConnectionId = job.data.destinationConnectionId;
                }
                if (!nextPayload.metadata && job.data.metadata) {
                  nextPayload.metadata = job.data.metadata;
                }
                if (mappedDestinationFields && mappedDestinationFields.length > 0) {
                  const currentMeta = typeof nextPayload.metadata === 'object' && nextPayload.metadata !== null ? nextPayload.metadata : {};
                  nextPayload.metadata = { ...currentMeta, mappedDestinationFields };
                }

                // Validate all required streaming metadata before outbox persistence
                if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SYNTHETIC_SOURCE === 'false') {
                  if (!nextPayload.sourceObject || !nextPayload.destinationObject) {
                    throw new Error(`[Worker Streaming] Missing required sourceObject or destinationObject for streaming batch ${nextPayload.batchKey}`);
                  }
                  if (!nextPayload.destinationKey) {
                    throw new Error(`[Worker Streaming] Missing required destinationKey for streaming batch ${nextPayload.batchKey}`);
                  }
                  if (!nextPayload.planVersionId) {
                    throw new Error(`[Worker Streaming] Missing required planVersionId for streaming batch ${nextPayload.batchKey}`);
                  }
                  if (!nextPayload.mappingVersionId) {
                    throw new Error(`[Worker Streaming] Missing required mappingVersionId for streaming batch ${nextPayload.batchKey}`);
                  }
                }

                console.log(`[Worker] Routing streaming batch through durable PENDING outbox: ${nextPayload.batchKey} (seq: ${nextPayload.sequenceNo})`);
                if (dbPool) {
                  // Route through durable PENDING outbox with complete metadata: never insert QUEUED directly
                  await dbPool.query(
                    `INSERT INTO migration_batches (
                       id, migration_run_id, batch_key, sequence_no, status,
                       source_object, destination_object, mapping_version_id,
                       source_connection_id, destination_connection_id, destination_key, plan_version_id, metadata,
                       source_cursor_start, source_cursor_end,
                       records_read, records_written, records_skipped, records_failed, attempt_count, updated_at
                     ) VALUES (
                       gen_random_uuid(), $1, $2, $3, 'PENDING',
                       $4, $5, $6,
                       $7, $8, $9, $10, $11,
                       $12, $13,
                       0, 0, 0, 0, 0, NOW()
                     ) ON CONFLICT (migration_run_id, batch_key) DO UPDATE SET
                       source_object = EXCLUDED.source_object,
                       destination_object = EXCLUDED.destination_object,
                       mapping_version_id = EXCLUDED.mapping_version_id,
                       source_connection_id = EXCLUDED.source_connection_id,
                       destination_connection_id = EXCLUDED.destination_connection_id,
                       destination_key = EXCLUDED.destination_key,
                       plan_version_id = EXCLUDED.plan_version_id,
                       metadata = EXCLUDED.metadata,
                       source_cursor_start = EXCLUDED.source_cursor_start,
                       source_cursor_end = EXCLUDED.source_cursor_end,
                       updated_at = NOW()`,
                    [
                      nextPayload.migrationRunId,
                      nextPayload.batchKey,
                      nextPayload.sequenceNo,
                      nextPayload.sourceObject,
                      nextPayload.destinationObject,
                      nextPayload.mappingVersionId || null,
                      nextPayload.sourceConnectionId || null,
                      nextPayload.destinationConnectionId || null,
                      nextPayload.destinationKey || null,
                      nextPayload.planVersionId || null,
                      JSON.stringify({
                        sourceConnectionId: nextPayload.sourceConnectionId,
                        destinationConnectionId: nextPayload.destinationConnectionId,
                        destinationKey: nextPayload.destinationKey,
                        planVersionId: nextPayload.planVersionId,
                        mappingVersionId: nextPayload.mappingVersionId,
                        ...(nextPayload.metadata || {}),
                      }),
                      JSON.stringify(nextPayload.cursorStart || {}),
                      JSON.stringify(nextPayload.cursorEnd || {}),
                    ],
                  );

                  // If executionQueue is active, transition from PENDING -> QUEUED atomically in a transaction
                  if (executionQueue) {
                    const client = await dbPool.connect();
                    try {
                      await client.query('BEGIN');
                      const claimRes = await client.query(
                        `SELECT * FROM migration_batches
                         WHERE migration_run_id = $1 AND batch_key = $2 AND status = 'PENDING'
                         FOR UPDATE SKIP LOCKED`,
                        [nextPayload.migrationRunId, nextPayload.batchKey],
                      );
                      if (claimRes.rows.length > 0) {
                        const jobId = `${nextPayload.migrationRunId}_${nextPayload.batchKey}`;
                        await executionQueue.add('execute-batch', nextPayload, {
                          jobId,
                          removeOnComplete: false,
                          removeOnFail: false,
                        });
                        await client.query(
                          `UPDATE migration_batches SET status = 'QUEUED', updated_at = NOW()
                           WHERE migration_run_id = $1 AND batch_key = $2`,
                          [nextPayload.migrationRunId, nextPayload.batchKey],
                        );
                      }
                      await client.query('COMMIT');
                    } catch (queueErr: any) {
                      await client.query('ROLLBACK').catch(() => {});
                      console.error(`[Worker] Failed to enqueue streaming batch to BullMQ: ${queueErr.message}. Batch remains PENDING in outbox.`);
                      throw queueErr;
                    } finally {
                      client.release();
                    }
                  }
                }
              }
            : undefined,
          isPausedOrCancelled: async (migrationRunId: string) => {
            if (!dbPool) return 'RUNNING';
            const check = await dbPool.query(
              `SELECT status FROM migration_runs WHERE id = $1`,
              [migrationRunId],
            );
            if (check.rows.length === 0) return 'RUNNING';
            const s = check.rows[0].status;
            if (s === 'PAUSED' || s === 'CANCELLED') return s;
            return 'RUNNING';
          },
        });

        // Execute real batch migration, write to destination, track manifests and checkpoint
        const result = await queueHandler.processJob(job.data);

        // Update run progress in PostgreSQL idempotently from migration_batches
        await recomputeMigrationRunProgress(job.data.migrationRunId);

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
        ...(BULLMQ_PREFIX ? { prefix: BULLMQ_PREFIX } : {}),
        concurrency: 2,
        stalledInterval: parseInt(process.env.BULLMQ_STALLED_INTERVAL || '2000', 10),
        lockDuration: parseInt(process.env.BULLMQ_LOCK_DURATION || '4000', 10),
        maxStalledCount: 3,
      },
    );

    // 3. Wait until BullMQ Worker is ready
    await executionWorker.waitUntilReady();

    executionWorker.on('stalled', (jobId) => {
      console.log(`[Worker] BullMQ detected stalled job and recovered it for execution: ${jobId}`);
    });

    executionWorker.on('completed', (job) => {
      console.log(`[Worker] Job ${job.id} marked COMPLETED.`);
    });

    executionWorker.on('failed', (job, err) => {
      console.error(`[Worker] Job ${job?.id} FAILED:`, err.message);
    });

    executionWorker.on('error', (err) => {
      console.error(`[Worker] BullMQ Worker error: ${err.message}`);
    });

    console.log('[Worker] Worker pools initialized:');
    console.log(`  ✔ BullMQ Queue: '${QUEUE_NAME}' (Concurrency: 2)`);
    console.log('  ✔ PostgreSQL destination ready');
    console.log('  ✔ Manifest & Checkpoint tracking active');
    console.log('  ✔ Encrypted Vault credential resolution active');
    console.log('[Worker] Worker is listening for jobs.\n');
  } catch (err: any) {
    console.error(`[Worker] Fatal error starting worker: ${err.message}`);
    if (redisClient) {
      try { redisClient.disconnect(); } catch {}
    }
    if (dbPool) {
      try { await dbPool.end(); } catch {}
    }
    process.exit(1);
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
  if (executionQueue) {
    await executionQueue.close();
    console.log('[Worker] Execution queue closed.');
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

  // Close all per-connection source connectors
  for (const [cacheKey, entry] of sourceConnectorCache.entries()) {
    try {
      if ('close' in entry.connector && typeof (entry.connector as any).close === 'function') {
        await (entry.connector as any).close();
      }
      console.log(`[Worker] Source connector closed: ${cacheKey}`);
    } catch (err: any) {
      console.warn(`[Worker] Error closing source connector ${cacheKey}: ${err.message}`);
    }
  }
  sourceConnectorCache.clear();

  if (dbPool) {
    await dbPool.end();
    console.log('[Worker] Control-plane database pool closed.');
  }

  console.log('[Worker] Worker process terminated gracefully.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { startWorker, shutdown };

const isDirectEntrypoint = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith('worker-main.js') || process.argv[1].endsWith('worker-main.ts'))
);

if (isDirectEntrypoint || process.env.RUN_STANDALONE_WORKER === 'true') {
  startWorker();
}
