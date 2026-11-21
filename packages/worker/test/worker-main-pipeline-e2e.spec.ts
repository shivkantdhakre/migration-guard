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

describe('Worker-Main Pipeline E2E & Crash/Recovery Lifecycle (Run 005.14)', { timeout: 60000 }, () => {
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
        SELECT column_name, column_default 
        FROM information_schema.columns 
        WHERE table_name = 'record_manifests'
      `);
      const manifestColNames = new Set(manifestColsCheck.rows.map((r) => r.column_name));
      expect(manifestColNames.has('migration_run_id')).toBe(true);
      expect(manifestColNames.has('batch_key')).toBe(true);
      expect(manifestColNames.has('source_object')).toBe(true);
      expect(manifestColNames.has('source_key')).toBe(true);
      expect(manifestColNames.has('destination_object')).toBe(true);
      expect(manifestColNames.has('destination_key')).toBe(true);
      expect(manifestColNames.has('content_hash')).toBe(true);
      expect(manifestColNames.has('status')).toBe(true);

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

      // 5. Seed Deterministic MongoDB Source Collection (Section 3)
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

      // 8. Robust Standalone Worker Process Launcher with Confirmed Readiness (Section 5)
      const startWorkerProcess = (extraEnv: Record<string, string> = {}): Promise<{ child: ChildProcess }> => {
        return new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [workerMainPath], {
            env: {
              ...process.env,
              DATABASE_URL: dbUrl,
              REDIS_URL: redisUrl,
              BULLMQ_QUEUE_NAME: testQueue,
              ENCRYPTION_KEY: encryptionKeyHex,
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
      // FAULT INJECTION PHASE 1: Abrupt Crash after DESTINATION_WRITTEN (Section 4)
      // =========================================================================
      console.log('\n--- PHASE 1: Fault Injection after DESTINATION_WRITTEN ---');

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
        removeOnComplete: true,
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

      // Launch replacement Worker 2 (clean execution, no fault injection)
      const w2 = await startWorkerProcess();
      workerChild2 = w2.child;

      // Re-dispatch Batch 1 to simulate BullMQ redelivery after worker crash
      await queue.add('execute-batch', batch1Payload, {
        jobId: `job_${runId}_batch_0001_recovery`,
        removeOnComplete: true,
      });

      // Poll for Batch 1 COMMITTED state
      let batch1Committed = false;
      const startWait1 = Date.now();
      while (Date.now() - startWait1 < 15000) {
        const bRes = await testPool.query(
          `SELECT status, records_written FROM migration_batches WHERE migration_run_id = $1 AND batch_key = $2`,
          [runId, 'batch_customers_0001'],
        );
        if (bRes.rows.length > 0 && bRes.rows[0].status === 'COMMITTED') {
          batch1Committed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(batch1Committed).toBe(true);

      // Independent Assertions (Section 1):
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

      // Verify genuine MongoDB data was extracted and written
      const sampleDestRow = await testPool.query(
        `SELECT id, name, email, tier FROM "${destTable}" WHERE id = 'cust_mongo_0001'`,
      );
      expect(sampleDestRow.rows.length).toBe(1);
      expect(sampleDestRow.rows[0].name).toBe('Customer 1');
      expect(sampleDestRow.rows[0].email).toBe('customer_1@example.com');

      // Stop Worker 2 before Phase 2
      workerChild2.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
      workerChild2 = null;

      // =========================================================================
      // FAULT INJECTION PHASE 2: Abrupt Crash after MANIFEST_COMMITTED (Section 4)
      // =========================================================================
      console.log('\n--- PHASE 2: Fault Injection after MANIFEST_COMMITTED ---');

      // Launch Worker 3 with simulated fault injection crash after manifest persistence
      const w3 = await startWorkerProcess({
        FAULT_INJECTION_EXIT_AFTER: 'MANIFEST_COMMITTED',
      });
      workerChild3 = w3.child;

      const worker3ExitedPromise = new Promise<{ code: number | null }>((resolve) => {
        workerChild3!.on('exit', (code) => resolve({ code }));
      });

      // Dispatch Batch 2 (documents 11-20 from MongoDB)
      const batch2Payload = {
        jobId: `job_${runId}_batch_0002`,
        migrationRunId: runId,
        batchKey: 'batch_customers_0002',
        sequenceNo: 2,
        sourceConnectionId: sourceConnId,
        destinationConnectionId: destConnId,
        sourceObject: sourceCollection,
        destinationObject: destTable,
        batchSize: 10,
        cursorStart: { lastId: 'cust_mongo_0010' },
        planVersionId: planVersionId,
        mappingVersionId: 'map-v1',
        writeMode: 'upsert',
      };

      await queue.add('execute-batch', batch2Payload, {
        jobId: batch2Payload.jobId,
        removeOnComplete: true,
      });

      // Worker 3 must crash abruptly mid-flight after writing manifests but before checkpoint commit
      const w3Exit = await worker3ExitedPromise;
      expect(w3Exit.code).toBe(137);
      workerChild3 = null;
      console.log('[Worker E2E] Confirmed Worker 3 terminated abruptly after MANIFEST_COMMITTED (exit code 137).');

      // Launch replacement Worker 4 (clean execution)
      const w4 = await startWorkerProcess();
      workerChild4 = w4.child;

      // Redeliver Batch 2 to Worker 4
      await queue.add('execute-batch', batch2Payload, {
        jobId: `job_${runId}_batch_0002_recovery`,
        removeOnComplete: true,
      });

      // Poll for Batch 2 COMMITTED state
      let batch2Committed = false;
      const startWait2 = Date.now();
      while (Date.now() - startWait2 < 15000) {
        const bRes = await testPool.query(
          `SELECT status, records_written FROM migration_batches WHERE migration_run_id = $1 AND batch_key = $2`,
          [runId, 'batch_customers_0002'],
        );
        if (bRes.rows.length > 0 && bRes.rows[0].status === 'COMMITTED') {
          batch2Committed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(batch2Committed).toBe(true);

      // Independent Assertions (Section 1):
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

      // Checkpoint state: sequence 2 committed
      const cpRow2 = await testPool.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
        [runId],
      );
      const cp2 = cpRow2.rows[0]?.source_boundary_json?.[sourceCollection];
      expect(cp2).toBeDefined();
      expect(cp2.lastCommittedSequenceNo).toBe(2);
      expect(cp2.committedSequences).toEqual([1, 2]);

      // =========================================================================
      // PHASE 3: Committed-Batch Redelivery Idempotency Test (Section 4)
      // =========================================================================
      console.log('\n--- PHASE 3: Committed-Batch Redelivery Idempotency Test ---');

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
      expect(cpFinal.lastCommittedSequenceNo).toBe(2);

      console.log('[Worker Main E2E] Pipeline verified with genuine MongoDB source, real PostgreSQL destination, mid-flight fault injection, and zero duplicate records.');
    } finally {
      // Teardown: terminate all workers, drain queue, clean up database and mongo
      if (workerChild1) workerChild1.kill('SIGKILL');
      if (workerChild2) workerChild2.kill('SIGKILL');
      if (workerChild3) workerChild3.kill('SIGKILL');
      if (workerChild4) workerChild4.kill('SIGKILL');

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
        await testPool.query(`DELETE FROM migration_batches WHERE migration_run_id = $1`, [runId]).catch(() => {});
        await testPool.query(`DELETE FROM record_manifests WHERE migration_run_id = $1`, [runId]).catch(() => {});
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
