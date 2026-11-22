import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Independent RFC 8785 JSON Canonicalization Oracle (Test-Only).
 * Implemented independently of production library to verify the hash contract without shared code.
 * Includes independent Unicode surrogate validation and active-recursion-path cycle tracking.
 */
function independentValidateUnicode(str: string, context = 'string'): void {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= str.length) {
        throw new TypeError(`[Test Oracle] Invalid Unicode ${context}: isolated high surrogate at index ${i}`);
      }
      const next = str.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`[Test Oracle] Invalid Unicode ${context}: malformed surrogate pair at index ${i}`);
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`[Test Oracle] Invalid Unicode ${context}: isolated low surrogate at index ${i}`);
    }
  }
}

function independentCanonicalize(value: unknown, activePath = new Set<object>()): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    independentValidateUnicode(value, 'string value');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '0';
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw new TypeError(`[Test Oracle] Invalid non-finite number: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('[Test Oracle] Invalid Date');
    }
    return JSON.stringify(value.toISOString());
  }
  if (value instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))) {
    return JSON.stringify(Buffer.from(value as Uint8Array).toString('base64'));
  }
  if (typeof value === 'object' && value !== null) {
    if (activePath.has(value)) {
      throw new TypeError('[Test Oracle] Converting circular structure to JSON');
    }
    activePath.add(value);
    try {
      const obj = value as Record<string, unknown>;
      if (typeof obj.toHexString === 'function') {
        const hex = (obj.toHexString as () => string)();
        independentValidateUnicode(hex, 'ObjectId string');
        return JSON.stringify(hex);
      }
      if (obj._bsontype === 'Decimal128' && typeof obj.toString === 'function') {
        const dec = obj.toString();
        independentValidateUnicode(dec, 'Decimal128 string');
        return JSON.stringify(dec);
      }
      if (obj._bsontype === 'ObjectId' && typeof obj.toString === 'function') {
        const oid = obj.toString();
        independentValidateUnicode(oid, 'ObjectId string');
        return JSON.stringify(oid);
      }
      if (Array.isArray(value)) {
        return '[' + value.map((item) => independentCanonicalize(item, activePath)).join(',') + ']';
      }
      const keys = Object.keys(obj);
      for (const k of keys) {
        independentValidateUnicode(k, 'property name');
      }
      // UTF-16 code unit lexicographic sort per RFC 8785 §3.2.3
      const sortedKeys = keys
        .filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function' && typeof obj[k] !== 'symbol')
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const parts = sortedKeys.map((k) => `${JSON.stringify(k)}:${independentCanonicalize(obj[k], activePath)}`);
      return '{' + parts.join(',') + '}';
    } finally {
      activePath.delete(value);
    }
  }
  return JSON.stringify(value);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerMainPath = path.resolve(__dirname, '../dist/worker-main.js');
const candidateSchemaPaths = [
  path.resolve(__dirname, '../../backend/src/database/schema.sql'),
  path.resolve(__dirname, '../../../packages/backend/src/database/schema.sql'),
  path.resolve(process.cwd(), 'packages/backend/src/database/schema.sql'),
  path.resolve(process.cwd(), 'src/database/schema.sql'),
];
const schemaSqlPath = candidateSchemaPaths.find((p) => fs.existsSync(p));

describe('Worker-Main Pipeline E2E & Crash/Recovery Lifecycle (Run 005.15)', { timeout: 180000 }, () => {
  const dbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL;

  const redisUrl =
    process.env.MIGRATIONGUARD_TEST_REDIS_URL ||
    process.env.REDIS_URL ||
    (process.env.REDIS_HOST
      ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`
      : 'redis://localhost:6379');

  const mongoUrl =
    process.env.MIGRATIONGUARD_TEST_MONGO_URL ||
    process.env.MONGO_URL ||
    'mongodb://localhost:27017/migrationguard_e2e_source';

  const encryptionKeyHex =
    process.env.ENCRYPTION_KEY ||
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  function encryptVaultSecret(payloadObj: any, hexKey: string) {
    const key = Buffer.from(hexKey, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let enc = cipher.update(JSON.stringify(payloadObj), 'utf8', 'hex');
    enc += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return {
      encryptedPayload: enc,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
    };
  }

  it('fails worker startup with non-zero exit code when dependencies are unreachable', async () => {
    // Spawns worker with an unreachable Redis port to verify fail-closed exit code 1
    const child = spawn(process.execPath, [workerMainPath], {
      env: {
        ...process.env,
        DATABASE_URL: dbUrl || 'postgresql://localhost:5432/migrationguard_test',
        REDIS_URL: 'redis://127.0.0.1:59999', // Closed port
        RUN_STANDALONE_WORKER: 'true',
        NODE_ENV: 'test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve(-1);
      }, 15000);
    });

    expect(exitCode).toBe(1);
  });

  it('executes full MongoDB-to-PostgreSQL pipeline, verifies schema contract, handles fault injection mid-flight, and guarantees zero duplicate records on recovery', async (ctx) => {
    if (!dbUrl) {
      if (process.env.CI === 'true') {
        throw new Error('[CI Mandatory Failure] MIGRATIONGUARD_TEST_DATABASE_URL is required in CI.');
      }
      console.warn('[Notice] Test database URL not configured, skipping worker-main pipeline E2E.');
      ctx.skip();
      return;
    }

    // 1. Probe PostgreSQL connectivity
    let testPool: pg.Pool;
    try {
      testPool = new pg.Pool({ connectionString: dbUrl, max: 5, connectionTimeoutMillis: 5000 });
      await testPool.query('SELECT 1');
    } catch (err: any) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] PostgreSQL unreachable in CI: ${err.message}`);
      }
      console.warn(`[Notice] PostgreSQL unreachable in local environment (${err.message}), skipping worker-main E2E.`);
      ctx.skip();
      return;
    }

    // 2. Probe Redis connectivity
    let redisProbe: Redis;
    try {
      redisProbe = new Redis(redisUrl, {
        connectTimeout: 4000,
        maxRetriesPerRequest: null,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      redisProbe.on('error', () => {});
      await redisProbe.connect();
      await redisProbe.ping();
    } catch (err: any) {
      await testPool.end().catch(() => {});
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] Redis unreachable in CI: ${err.message}`);
      }
      console.warn(`[Notice] Redis unreachable in local environment (${err.message}), skipping worker-main E2E.`);
      ctx.skip();
      return;
    }

    // 3. Probe MongoDB connectivity
    let mongoClient: MongoClient;
    try {
      mongoClient = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 4000 });
      await mongoClient.connect();
      await mongoClient.db().command({ ping: 1 });
    } catch (err: any) {
      redisProbe.disconnect();
      await testPool.end().catch(() => {});
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] MongoDB unreachable in CI: ${err.message}`);
      }
      console.warn(`[Notice] MongoDB unreachable in local environment (${err.message}), skipping worker-main E2E.`);
      ctx.skip();
      return;
    }

    const testSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testQueue = `test-e2e-worker-${testSuffix}`;
    const workspaceId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    const planVersionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const sourceConnId = crypto.randomUUID();
    const destConnId = crypto.randomUUID();
    const sourceCollection = `customers_src_${testSuffix}`;
    const destTable = `customers_dest_${testSuffix}`;
    const mongoDbName = mongoClient.db().databaseName || 'migrationguard_e2e_source';

    let workerChild1: ChildProcess | null = null;
    let workerChild2: ChildProcess | null = null;
    let workerChild3: ChildProcess | null = null;
    let workerChild4: ChildProcess | null = null;
    let workerChild5: ChildProcess | null = null;
    let workerChild6: ChildProcess | null = null;
    let queue: Queue | null = null;

    try {
      // 4. Align and Execute Canonical Production Schema (Section 6)
      if (schemaSqlPath && fs.existsSync(schemaSqlPath)) {
        const canonicalSchemaSql = fs.readFileSync(schemaSqlPath, 'utf8');
        await testPool.query(canonicalSchemaSql);
      }

      // Explicit schema contract verification for required tables, constraints, and columns
      const tablesCheck = await testPool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('workspaces', 'connections', 'connection_secrets', 'migration_runs', 'migration_batches', 'record_manifests', 'id_mappings')
      `);
      const existingTables = new Set(tablesCheck.rows.map((r) => r.table_name));
      expect(existingTables.has('workspaces')).toBe(true);
      expect(existingTables.has('connections')).toBe(true);
      expect(existingTables.has('connection_secrets')).toBe(true);
      expect(existingTables.has('migration_runs')).toBe(true);
      expect(existingTables.has('migration_batches')).toBe(true);
      expect(existingTables.has('record_manifests')).toBe(true);
      expect(existingTables.has('id_mappings')).toBe(true);

      const manifestColsCheck = await testPool.query(`
        SELECT column_name, is_nullable 
        FROM information_schema.columns 
        WHERE table_name = 'record_manifests'
      `);
      const manifestColMap = new Map(manifestColsCheck.rows.map((r) => [r.column_name, r.is_nullable]));
      expect(manifestColMap.has('migration_run_id')).toBe(true);
      expect(manifestColMap.has('migration_batch_id')).toBe(true);
      expect(manifestColMap.has('batch_key')).toBe(true);
      expect(manifestColMap.has('source_object')).toBe(true);
      expect(manifestColMap.has('source_key')).toBe(true);
      expect(manifestColMap.has('destination_object')).toBe(true);
      expect(manifestColMap.get('destination_object')).toBe('NO'); // NOT NULL
      expect(manifestColMap.has('destination_key')).toBe(true);
      expect(manifestColMap.get('destination_key')).toBe('NO'); // NOT NULL
      expect(manifestColMap.has('content_hash')).toBe(true);
      expect(manifestColMap.has('status')).toBe(true);

      // Create test-specific destination table matching canonical schema
      await testPool.query(`
        CREATE TABLE IF NOT EXISTS "${destTable}" (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT,
          phone TEXT,
          tier TEXT,
          status TEXT,
          metadata JSONB DEFAULT '{}'::jsonb,
          run_id TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // 5. Seed Deterministic MongoDB Source Collection (Section 3) - 20 Documents
      const seedCustomers = Array.from({ length: 20 }, (_, idx) => {
        const num = idx + 1;
        const id = `cust_mongo_${String(num).padStart(4, '0')}`;
        return {
          _id: id,
          name: `Customer ${num}`,
          email: `customer_${num}@example.com`,
          phone: `+1-555-${String(num).padStart(4, '0')}`,
          tier: num % 3 === 0 ? 'ENTERPRISE' : 'STANDARD',
          status: 'ACTIVE',
          createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
          metadata: { seededBy: 'e2e_mongo_pipeline', sequence: num },
        };
      });

      const mongoDb = mongoClient.db(mongoDbName);
      const sourceColl = mongoDb.collection(sourceCollection);
      await sourceColl.deleteMany({});
      await sourceColl.insertMany(seedCustomers);

      // 6. Seed Workspace, Project, Connections, Plan, Plan Version, Secrets, and Migration Run matching Canonical Production Schema
      await testPool.query(
        `INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)`,
        [workspaceId, `E2E Workspace ${testSuffix}`, `e2e-ws-${testSuffix}`],
      );

      await testPool.query(
        `INSERT INTO projects (id, workspace_id, name, description) VALUES ($1, $2, $3, $4)`,
        [projectId, workspaceId, `E2E Project ${testSuffix}`, 'E2E Testing Project'],
      );

      // MongoDB Source Connection Vault Record
      await testPool.query(
        `INSERT INTO connections (id, workspace_id, name, engine, connection_role, config_json, credential_version, status)
         VALUES ($1, $2, 'Test Source MongoDB', 'MONGODB', 'SOURCE', $3, 1, 'HEALTHY')`,
        [sourceConnId, workspaceId, JSON.stringify({ database: mongoDbName })],
      );

      const mongoSecret = encryptVaultSecret({ uri: mongoUrl, connectionString: mongoUrl }, encryptionKeyHex);
      await testPool.query(
        `INSERT INTO connection_secrets (connection_id, version, encrypted_payload, iv, auth_tag)
         VALUES ($1, $2, $3, $4, $5)`,
        [sourceConnId, 1, mongoSecret.encryptedPayload, mongoSecret.iv, mongoSecret.authTag],
      );

      // PostgreSQL Destination Connection Vault Record
      await testPool.query(
        `INSERT INTO connections (id, workspace_id, name, engine, connection_role, config_json, credential_version, status)
         VALUES ($1, $2, 'Test Destination PostgreSQL', 'POSTGRESQL', 'DESTINATION', '{}'::jsonb, 1, 'HEALTHY')`,
        [destConnId, workspaceId],
      );

      const pgSecret = encryptVaultSecret({ connectionString: dbUrl }, encryptionKeyHex);
      await testPool.query(
        `INSERT INTO connection_secrets (connection_id, version, encrypted_payload, iv, auth_tag)
         VALUES ($1, $2, $3, $4, $5)`,
        [destConnId, 1, pgSecret.encryptedPayload, pgSecret.iv, pgSecret.authTag],
      );

      // Migration Plan & Version matching Canonical Production Schema
      await testPool.query(
        `INSERT INTO migration_plans (id, workspace_id, project_id, name, status, current_version)
         VALUES ($1, $2, $3, 'E2E Plan', 'APPROVED', 1)`,
        [planId, workspaceId, projectId],
      );

      await testPool.query(
        `INSERT INTO migration_plan_versions (id, plan_id, version, source_connection_id, destination_connection_id, plan_hash)
         VALUES ($1, $2, 1, $3, $4, 'e2e_plan_hash_001')`,
        [planVersionId, planId, sourceConnId, destConnId],
      );

      // Migration Run Record matching Canonical Production Schema
      await testPool.query(
        `INSERT INTO migration_runs (id, workspace_id, project_id, plan_version_id, status)
         VALUES ($1, $2, $3, $4, 'RUNNING')`,
        [runId, workspaceId, projectId, planVersionId],
      );

      // 7. Create BullMQ Queue Producer
      queue = new Queue(testQueue, {
        connection: {
          host: redisProbe.options.host || 'localhost',
          port: redisProbe.options.port || 6379,
          password: redisProbe.options.password,
          tls: redisProbe.options.tls,
          maxRetriesPerRequest: null,
        },
      });

      // 8. Robust Standalone Worker Process Launcher with Confirmed Readiness
      const startWorkerProcess = (extraEnv: Record<string, string> = {}): Promise<{ child: ChildProcess }> => {
        return new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [workerMainPath], {
            env: {
              ...process.env,
              DATABASE_URL: dbUrl,
              REDIS_URL: redisUrl,
              BULLMQ_QUEUE_NAME: testQueue,
              ENCRYPTION_KEY: encryptionKeyHex,
              BULLMQ_LOCK_DURATION: '3500',
              BULLMQ_STALLED_INTERVAL: '1500',
              RUN_STANDALONE_WORKER: 'true',
              NODE_ENV: 'test',
              ...extraEnv,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          let started = false;
          let startupTimeout: NodeJS.Timeout | null = null;

          const onData = (data: Buffer) => {
            const str = data.toString();
            if (str.includes('[Worker] Worker is listening for jobs.')) {
              if (!started) {
                started = true;
                if (startupTimeout) clearTimeout(startupTimeout);
                resolve({ child });
              }
            }
          };

          child.stdout?.pipe(process.stdout);
          child.stderr?.pipe(process.stderr);
          child.stdout?.on('data', onData);
          child.stderr?.on('data', onData);

          child.on('error', (err) => {
            if (!started) {
              if (startupTimeout) clearTimeout(startupTimeout);
              reject(err);
            }
          });

          child.on('exit', (code, signal) => {
            if (!started) {
              if (startupTimeout) clearTimeout(startupTimeout);
              reject(new Error(`Worker exited before becoming ready (code=${code}, signal=${signal})`));
            }
          });

          // Strict timeout: reject if readiness signal not received (no synthetic auto-resolve!)
          startupTimeout = setTimeout(() => {
            if (!started) {
              child.kill('SIGKILL');
              reject(new Error('Worker startup timed out waiting for readiness signal ([Worker] Worker is listening for jobs.)'));
            }
          }, 15000);
        });
      };

      // =========================================================================
      // FAULT INJECTION PHASE 1: Abrupt Crash after DESTINATION_WRITTEN
      // Genuine BullMQ Stalled-Job Recovery (Preserving original Job ID)
      // =========================================================================
      console.log('\n--- PHASE 1: Fault Injection after DESTINATION_WRITTEN & BullMQ Stalled Recovery ---');

      // Launch Worker 1 with simulated fault injection crash after destination write
      const w1 = await startWorkerProcess({
        FAULT_INJECTION_EXIT_AFTER: 'DESTINATION_WRITTEN',
      });
      workerChild1 = w1.child;

      const worker1ExitedPromise = new Promise<{ code: number | null }>((resolve) => {
        workerChild1!.on('exit', (code) => resolve({ code }));
      });

      // Dispatch Batch 1 (extracts first 10 documents from MongoDB)
      const batch1Payload = {
        jobId: `job_${runId}_batch_0001`,
        migrationRunId: runId,
        batchKey: 'batch_customers_0001',
        sequenceNo: 1,
        sourceConnectionId: sourceConnId,
        destinationConnectionId: destConnId,
        sourceObject: sourceCollection,
        destinationObject: destTable,
        batchSize: 10,
        planVersionId: planVersionId,
        mappingVersionId: 'map-v1',
        writeMode: 'upsert',
      };

      await queue.add('execute-batch', batch1Payload, {
        jobId: batch1Payload.jobId,
        removeOnComplete: false,
      });

      // Worker 1 must crash abruptly mid-flight while the job is active
      const w1Exit = await worker1ExitedPromise;
      expect(w1Exit.code).toBe(137);
      workerChild1 = null;
      console.log('[Worker E2E] Confirmed Worker 1 terminated abruptly via fault injection (exit code 137).');

      // Verify intermediate crash state: records were written to destination, but manifests were NOT committed
      const midDest1 = await testPool.query(`SELECT COUNT(*)::int as count FROM "${destTable}"`);
      expect(midDest1.rows[0].count).toBe(10);

      const midManifests1 = await testPool.query(
        `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1 AND status = 'WRITTEN'`,
        [runId],
      );
      expect(midManifests1.rows[0].count).toBe(0);

      // Wait for BullMQ lock duration to expire so the job can be recognized as stalled
      console.log('[Worker E2E] Awaiting BullMQ lock expiration for stalled-job detection...');
      await new Promise((r) => setTimeout(r, 4000));

      // Launch replacement Worker 2 (clean execution, no fault injection)
      // DO NOT call queue.add() — let BullMQ stalled-job detector pick up original job!
      const w2 = await startWorkerProcess();
      workerChild2 = w2.child;

      // Poll until original job completes via BullMQ stalled-job recovery
      let job1 = await queue.getJob(batch1Payload.jobId);
      const startWait1 = Date.now();
      while (Date.now() - startWait1 < 25000) {
        if (job1 && (await job1.isCompleted())) {
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
        job1 = await queue.getJob(batch1Payload.jobId);
      }
      expect(job1).toBeDefined();
      expect(await job1!.isCompleted()).toBe(true);

      // Verify Batch 1 reached COMMITTED in PostgreSQL database
      const b1Res = await testPool.query(
        `SELECT status, records_written FROM migration_batches WHERE migration_run_id = $1 AND batch_key = $2`,
        [runId, 'batch_customers_0001'],
      );
      expect(b1Res.rows.length).toBe(1);
      expect(b1Res.rows[0].status).toBe('COMMITTED');

      // Independent Assertions (Phase 1):
      // Destination count: exactly 10 (idempotent upsert ensured ZERO duplicate records)
      const destCount1 = await testPool.query(`SELECT COUNT(*)::int as count FROM "${destTable}"`);
      expect(destCount1.rows[0].count).toBe(10);

      // Written manifest count: exactly 10
      const writtenManifestCount1 = await testPool.query(
        `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1 AND status = 'WRITTEN'`,
        [runId],
      );
      expect(writtenManifestCount1.rows[0].count).toBe(10);

      // Failed manifest count: 0
      const failedManifestCount1 = await testPool.query(
        `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1 AND status = 'FAILED'`,
        [runId],
      );
      expect(failedManifestCount1.rows[0].count).toBe(0);

      // Checkpoint state: sequence 1
      const cpRow1 = await testPool.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
        [runId],
      );
      const cp1 = cpRow1.rows[0]?.source_boundary_json?.[sourceCollection];
      expect(cp1).toBeDefined();
      expect(cp1.lastCommittedSequenceNo).toBe(1);
      expect(cp1.committedSequences).toEqual([1]);

      // Stop Worker 2 before Phase 2
      workerChild2.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
      workerChild2 = null;

      // =========================================================================
      // FAULT INJECTION PHASE 2: Abrupt Crash after MANIFEST_COMMITTED
      // Genuine BullMQ Stalled-Job Recovery (Preserving original Job ID)
      // =========================================================================
      console.log('\n--- PHASE 2: Fault Injection after MANIFEST_COMMITTED & BullMQ Stalled Recovery ---');

      // Launch Worker 3 with simulated fault injection crash after manifest persistence
      const w3 = await startWorkerProcess({
        FAULT_INJECTION_EXIT_AFTER: 'MANIFEST_COMMITTED',
      });
      workerChild3 = w3.child;

      const worker3ExitedPromise = new Promise<{ code: number | null }>((resolve) => {
        workerChild3!.on('exit', (code) => resolve({ code }));
      });

      // Dispatch Batch 2 (documents 11-15 from MongoDB)
      const batch2Payload = {
        jobId: `job_${runId}_batch_0002`,
        migrationRunId: runId,
        batchKey: 'batch_customers_0002',
        sequenceNo: 2,
        sourceConnectionId: sourceConnId,
        destinationConnectionId: destConnId,
        sourceObject: sourceCollection,
        destinationObject: destTable,
        batchSize: 5,
        cursorStart: { lastId: 'cust_mongo_0010' },
        planVersionId: planVersionId,
        mappingVersionId: 'map-v1',
        writeMode: 'upsert',
      };

      await queue.add('execute-batch', batch2Payload, {
        jobId: batch2Payload.jobId,
        removeOnComplete: false,
      });

      // Worker 3 must crash abruptly mid-flight after writing manifests but before checkpoint commit
      const w3Exit = await worker3ExitedPromise;
      expect(w3Exit.code).toBe(137);
      workerChild3 = null;
      console.log('[Worker E2E] Confirmed Worker 3 terminated abruptly after MANIFEST_COMMITTED (exit code 137).');

      // Verify intermediate crash state: records written (15 total), manifests written (15 total), checkpoint still 1
      const midDest2 = await testPool.query(`SELECT COUNT(*)::int as count FROM "${destTable}"`);
      expect(midDest2.rows[0].count).toBe(15);

      const midCpRow2 = await testPool.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
        [runId],
      );
      const midCp2 = midCpRow2.rows[0]?.source_boundary_json?.[sourceCollection];
      expect(midCp2?.lastCommittedSequenceNo).toBe(1);

      // Wait for BullMQ lock duration to expire so the job can be recognized as stalled
      console.log('[Worker E2E] Awaiting BullMQ lock expiration for Phase 2 stalled-job detection...');
      await new Promise((r) => setTimeout(r, 4000));

      // Launch replacement Worker 4 (clean execution)
      // DO NOT call queue.add() — let BullMQ stalled-job detector pick up original job!
      const w4 = await startWorkerProcess();
      workerChild4 = w4.child;

      // Poll until original job 2 completes via BullMQ stalled-job recovery
      let job2 = await queue.getJob(batch2Payload.jobId);
      const startWait2 = Date.now();
      while (Date.now() - startWait2 < 25000) {
        if (job2 && (await job2.isCompleted())) {
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
        job2 = await queue.getJob(batch2Payload.jobId);
      }
      expect(job2).toBeDefined();
      expect(await job2!.isCompleted()).toBe(true);

      // Verify Batch 2 reached COMMITTED in database
      const b2Res = await testPool.query(
        `SELECT status, records_written FROM migration_batches WHERE migration_run_id = $1 AND batch_key = $2`,
        [runId, 'batch_customers_0002'],
      );
      expect(b2Res.rows.length).toBe(1);
      expect(b2Res.rows[0].status).toBe('COMMITTED');

      // Independent Assertions (Phase 2):
      const destCount2 = await testPool.query(`SELECT COUNT(*)::int as count FROM "${destTable}"`);
      expect(destCount2.rows[0].count).toBe(15);

      const writtenManifestCount2 = await testPool.query(
        `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1 AND status = 'WRITTEN'`,
        [runId],
      );
      expect(writtenManifestCount2.rows[0].count).toBe(15);

      const failedManifestCount2 = await testPool.query(
        `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1 AND status = 'FAILED'`,
        [runId],
      );
      expect(failedManifestCount2.rows[0].count).toBe(0);

      // Checkpoint state: sequence 2 committed
      const cpRow2 = await testPool.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
        [runId],
      );
      const cp2 = cpRow2.rows[0]?.source_boundary_json?.[sourceCollection];
      expect(cp2).toBeDefined();
      expect(cp2.lastCommittedSequenceNo).toBe(2);
      expect(cp2.committedSequences).toEqual([1, 2]);

      // Stop Worker 4 before Phase 3
      workerChild4.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
      workerChild4 = null;

      // =========================================================================
      // FAULT INJECTION PHASE 3: Abrupt Crash after CHECKPOINT_ADVANCED
      // Boundary between checkpoint advancement and batch state commit
      // Genuine BullMQ Stalled-Job Recovery
      // =========================================================================
      console.log('\n--- PHASE 3: Fault Injection after CHECKPOINT_ADVANCED & BullMQ Stalled Recovery ---');

      // Launch Worker 5 with simulated fault injection crash after checkpoint advance
      const w5 = await startWorkerProcess({
        FAULT_INJECTION_EXIT_AFTER: 'CHECKPOINT_ADVANCED',
      });
      workerChild5 = w5.child;

      const worker5ExitedPromise = new Promise<{ code: number | null }>((resolve) => {
        workerChild5!.on('exit', (code) => resolve({ code }));
      });

      // Dispatch Batch 3 (documents 16-20 from MongoDB)
      const batch3Payload = {
        jobId: `job_${runId}_batch_0003`,
        migrationRunId: runId,
        batchKey: 'batch_customers_0003',
        sequenceNo: 3,
        sourceConnectionId: sourceConnId,
        destinationConnectionId: destConnId,
        sourceObject: sourceCollection,
        destinationObject: destTable,
        batchSize: 5,
        cursorStart: { lastId: 'cust_mongo_0015' },
        planVersionId: planVersionId,
        mappingVersionId: 'map-v1',
        writeMode: 'upsert',
      };

      await queue.add('execute-batch', batch3Payload, {
        jobId: batch3Payload.jobId,
        removeOnComplete: false,
      });

      // Worker 5 must crash abruptly after checkpoint advanced, before batch COMMITTED
      const w5Exit = await worker5ExitedPromise;
      expect(w5Exit.code).toBe(137);
      workerChild5 = null;
      console.log('[Worker E2E] Confirmed Worker 5 terminated abruptly after CHECKPOINT_ADVANCED (exit code 137).');

      // Verify intermediate crash state:
      // Checkpoint is already advanced to 3, but migration_batches status is still RUNNING
      const midCpRow3 = await testPool.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
        [runId],
      );
      const midCp3 = midCpRow3.rows[0]?.source_boundary_json?.[sourceCollection];
      expect(midCp3).toBeDefined();
      expect(midCp3.lastCommittedSequenceNo).toBe(3);

      const midBatch3 = await testPool.query(
        `SELECT status FROM migration_batches WHERE migration_run_id = $1 AND batch_key = $2`,
        [runId, 'batch_customers_0003'],
      );
      expect(midBatch3.rows.length).toBe(1);
      expect(midBatch3.rows[0].status).toBe('RUNNING'); // Not committed yet!

      // Wait for BullMQ lock duration to expire so the job can be recognized as stalled
      console.log('[Worker E2E] Awaiting BullMQ lock expiration for Phase 3 stalled-job detection...');
      await new Promise((r) => setTimeout(r, 4000));

      // Launch replacement Worker 6 (clean execution)
      // DO NOT call queue.add() — let BullMQ stalled-job detector pick up original job!
      const w6 = await startWorkerProcess();
      workerChild6 = w6.child;

      // Poll until original job 3 completes via BullMQ stalled-job recovery
      let job3 = await queue.getJob(batch3Payload.jobId);
      const startWait3 = Date.now();
      while (Date.now() - startWait3 < 25000) {
        if (job3 && (await job3.isCompleted())) {
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
        job3 = await queue.getJob(batch3Payload.jobId);
      }
      expect(job3).toBeDefined();
      expect(await job3!.isCompleted()).toBe(true);

      // Verify Batch 3 reached COMMITTED in database
      const b3Res = await testPool.query(
        `SELECT status, records_written FROM migration_batches WHERE migration_run_id = $1 AND batch_key = $2`,
        [runId, 'batch_customers_0003'],
      );
      expect(b3Res.rows.length).toBe(1);
      expect(b3Res.rows[0].status).toBe('COMMITTED');

      // Total destination count: exactly 20 records (ZERO duplicate records, ZERO lost records)
      const totalDestCount = await testPool.query(`SELECT COUNT(*)::int as count FROM "${destTable}"`);
      expect(totalDestCount.rows[0].count).toBe(20);

      // Total written manifests count: exactly 20 records
      const totalWrittenManifests = await testPool.query(
        `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1 AND status = 'WRITTEN'`,
        [runId],
      );
      expect(totalWrittenManifests.rows[0].count).toBe(20);

      // Failed manifests count: 0
      const totalFailedManifests = await testPool.query(
        `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1 AND status = 'FAILED'`,
        [runId],
      );
      expect(totalFailedManifests.rows[0].count).toBe(0);

      // Checkpoint state: sequence 3 committed, total sequences [1, 2, 3]
      const cpRow3 = await testPool.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
        [runId],
      );
      const cp3 = cpRow3.rows[0]?.source_boundary_json?.[sourceCollection];
      expect(cp3).toBeDefined();
      expect(cp3.lastCommittedSequenceNo).toBe(3);
      expect(cp3.committedSequences).toEqual([1, 2, 3]);

      // =========================================================================
      // PHASE 4: Committed-Batch Redelivery Idempotency Test
      // =========================================================================
      console.log('\n--- PHASE 4: Committed-Batch Redelivery Idempotency Test ---');

      await queue.add('execute-batch', batch1Payload, {
        jobId: `job_${runId}_batch_0001_idempotency_check`,
        removeOnComplete: true,
      });

      await new Promise((r) => setTimeout(r, 2500));

      // Assert zero duplicate records, zero duplicate manifests, checkpoint intact
      const afterRedeliveryDestCount = await testPool.query(`SELECT COUNT(*)::int as count FROM "${destTable}"`);
      expect(afterRedeliveryDestCount.rows[0].count).toBe(20);

      const afterRedeliveryManifests = await testPool.query(
        `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1 AND status = 'WRITTEN'`,
        [runId],
      );
      expect(afterRedeliveryManifests.rows[0].count).toBe(20);

      const cpRowFinal = await testPool.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
        [runId],
      );
      const cpFinal = cpRowFinal.rows[0]?.source_boundary_json?.[sourceCollection];
      expect(cpFinal.lastCommittedSequenceNo).toBe(3);

      // =========================================================================
      // PHASE 5: Deep Data-Level Validation (Requirement 5)
      // 1-to-1 comparison of every seeded MongoDB document against PostgreSQL
      // =========================================================================
      console.log('\n--- PHASE 5: Deep Data-Level Validation (MongoDB -> PostgreSQL 1-to-1) ---');

      // 1. Fetch all 20 rows from PostgreSQL destination table
      const destResult = await testPool.query(
        `SELECT id, name, email, phone, tier, status, metadata FROM "${destTable}" ORDER BY id ASC`,
      );
      expect(destResult.rows.length).toBe(20);

      const destMap = new Map(destResult.rows.map((r) => [r.id, r]));

      // Verify every single seeded MongoDB customer document exists exactly once and matches data fields
      for (const seed of seedCustomers) {
        const destRow = destMap.get(seed._id);
        expect(destRow).toBeDefined();
        expect(destRow.id).toBe(seed._id);
        expect(destRow.name).toBe(seed.name);
        expect(destRow.email).toBe(seed.email);
        expect(destRow.phone).toBe(seed.phone);
        expect(destRow.tier).toBe(seed.tier);
        expect(destRow.status).toBe(seed.status);

        const rowMeta = typeof destRow.metadata === 'string' ? JSON.parse(destRow.metadata) : destRow.metadata;
        expect(rowMeta).toBeDefined();
        // Deep metadata equality
        expect(rowMeta).toEqual(seed.metadata);
        // Confirm no extra or missing metadata properties
        expect(Object.keys(rowMeta).sort()).toEqual(Object.keys(seed.metadata).sort());
      }

      // 2. Verify id_mappings table: all 20 records mapped with correct source & destination coordinates
      const idMapResult = await testPool.query(
        `SELECT source_key, destination_key, source_object, destination_object 
         FROM id_mappings 
         WHERE migration_run_id = $1 
         ORDER BY source_key ASC`,
        [runId],
      );
      expect(idMapResult.rows.length).toBe(20);
      const idMapKeys = new Set(idMapResult.rows.map((r) => r.source_key));
      expect(idMapKeys.size).toBe(20);

      for (const mapRow of idMapResult.rows) {
        expect(mapRow.source_object).toBe(sourceCollection);
        expect(mapRow.destination_object).toBe(destTable);
        expect(mapRow.destination_key).toBe(mapRow.source_key);
        expect(mapRow.source_key.startsWith('cust_mongo_')).toBe(true);
      }

      // 3. Verify record_manifests table: all 20 manifests are WRITTEN, have SHA256 content hashes,
      // non-null destination coordinates, and valid composite foreign keys
      const manifestResult = await testPool.query(
        `SELECT m.source_key, m.destination_key, m.source_object, m.destination_object, 
                m.status, m.content_hash, m.migration_batch_id, b.batch_key
         FROM record_manifests m
         JOIN migration_batches b ON b.id = m.migration_batch_id AND b.batch_key = m.batch_key
         WHERE m.migration_run_id = $1 
         ORDER BY m.source_key ASC`,
        [runId],
      );
      expect(manifestResult.rows.length).toBe(20);

      for (const mRow of manifestResult.rows) {
        expect(mRow.status).toBe('WRITTEN');
        expect(mRow.source_object).toBe(sourceCollection);
        expect(mRow.destination_object).toBe(destTable);
        expect(mRow.destination_key).toBe(mRow.source_key);
        expect(mRow.migration_batch_id).toBeDefined();
        expect(typeof mRow.migration_batch_id).toBe('string');
        expect(mRow.batch_key).toMatch(/^batch_customers_000[123]$/);
        expect(mRow.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

        // Independent RFC 8785 canonical SHA-256 verification (Requirement 2 & 4)
        // Uses independent test-only oracle completely decoupled from @migrationguard/core
        const originalSeed = seedCustomers.find((s) => s._id === mRow.source_key);
        expect(originalSeed).toBeDefined();
        const expectedCanonicalJson = independentCanonicalize(originalSeed);
        const expectedDigest = crypto.createHash('sha256').update(expectedCanonicalJson).digest('hex');
        const expectedContentHash = `sha256:${expectedDigest}`;
        expect(mRow.content_hash).toBe(expectedContentHash);
      }

      // 4. Verify Final Checkpoint Progression
      expect(cpFinal.lastCommittedSequenceNo).toBe(3);
      expect(cpFinal.committedSequences).toEqual([1, 2, 3]);
      expect(cpFinal.totalRecordsCommitted).toBe(20);

      console.log('[Worker Main E2E] Pipeline fully verified: genuine BullMQ stalled-job recovery, crash boundary at CHECKPOINT_ADVANCED, and 1-to-1 data fidelity.');
    } finally {
      // Teardown: terminate all workers, drain queue, clean up database and mongo
      if (workerChild1) workerChild1.kill('SIGKILL');
      if (workerChild2) workerChild2.kill('SIGKILL');
      if (workerChild3) workerChild3.kill('SIGKILL');
      if (workerChild4) workerChild4.kill('SIGKILL');
      if (workerChild5) workerChild5.kill('SIGKILL');
      if (workerChild6) workerChild6.kill('SIGKILL');

      if (queue) {
        await queue.drain().catch(() => {});
        await queue.obliterate({ force: true }).catch(() => {});
        await queue.close().catch(() => {});
      }
      if (redisProbe) {
        redisProbe.disconnect();
      }
      if (mongoClient) {
        try {
          await mongoClient.db(mongoDbName).collection(sourceCollection).drop();
        } catch {}
        await mongoClient.close().catch(() => {});
      }
      if (testPool) {
        await testPool.query(`DROP TABLE IF EXISTS "${destTable}" CASCADE`).catch(() => {});
        await testPool.query(`DELETE FROM record_manifests WHERE migration_run_id = $1`, [runId]).catch(() => {});
        await testPool.query(`DELETE FROM migration_batches WHERE migration_run_id = $1`, [runId]).catch(() => {});
        await testPool.query(`DELETE FROM id_mappings WHERE migration_run_id = $1`, [runId]).catch(() => {});
        await testPool.query(`DELETE FROM migration_runs WHERE id = $1`, [runId]).catch(() => {});
        await testPool.query(`DELETE FROM migration_plan_versions WHERE id = $1`, [planVersionId]).catch(() => {});
        await testPool.query(`DELETE FROM migration_plans WHERE id = $1`, [planId]).catch(() => {});
        await testPool.query(`DELETE FROM connection_secrets WHERE connection_id IN ($1, $2)`, [sourceConnId, destConnId]).catch(() => {});
        await testPool.query(`DELETE FROM connections WHERE id IN ($1, $2)`, [sourceConnId, destConnId]).catch(() => {});
        await testPool.query(`DELETE FROM projects WHERE id = $1`, [projectId]).catch(() => {});
        await testPool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => {});
        await testPool.end().catch(() => {});
      }
    }
  });
});
