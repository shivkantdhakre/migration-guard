import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerMainPath = path.resolve(__dirname, '../dist/worker-main.js');

describe('Worker-Main Pipeline E2E & Crash/Recovery Lifecycle (Run 005.13 P2)', { timeout: 45000 }, () => {
  const dbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;
  const redisUrl =
    process.env.MIGRATIONGUARD_TEST_REDIS_URL ||
    process.env.REDIS_URL ||
    (process.env.REDIS_HOST
      ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`
      : 'redis://localhost:6379');

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

  it('executes full worker-main pipeline from Queue to Vault to Destination DB, recovers after crash without duplicates', async (ctx) => {
    if (!dbUrl) {
      if (process.env.CI === 'true') {
        throw new Error('[CI Mandatory Failure] MIGRATIONGUARD_TEST_DATABASE_URL is required in CI.');
      }
      console.warn('[Notice] Test database URL not configured, skipping worker-main pipeline E2E.');
      ctx.skip();
      return;
    }

    // 1. Probe PostgreSQL and Redis connectivity
    let testPool: pg.Pool;
    try {
      testPool = new pg.Pool({ connectionString: dbUrl, max: 5, connectionTimeoutMillis: 5000 });
      await testPool.query('SELECT 1');
    } catch (err: any) {
      if (process.env.CI === 'true') {
        throw new Error(`[CI Mandatory Failure] PostgreSQL unreachable in CI: ${err.message}`);
      }
      console.warn(`[Notice] PostgreSQL unreachable in sandbox (${err.message}), skipping worker-main E2E.`);
      ctx.skip();
      return;
    }

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
      console.warn(`[Notice] Redis unreachable in sandbox (${err.message}), skipping worker-main E2E.`);
      ctx.skip();
      return;
    }

    const testSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testQueue = `test-e2e-worker-${testSuffix}`;
    const workspaceId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const destConnId = crypto.randomUUID();
    const destTable = `customers_e2e_${testSuffix}`;

    let workerChild1: ChildProcess | null = null;
    let workerChild2: ChildProcess | null = null;
    let queue: Queue | null = null;

    try {
      // 2. Initialize required database tables
      await testPool.query(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS connections (
          id UUID PRIMARY KEY,
          workspace_id UUID NOT NULL,
          name TEXT NOT NULL,
          engine TEXT NOT NULL,
          connection_role TEXT NOT NULL,
          config_json JSONB NOT NULL DEFAULT '{}',
          secret_ref TEXT,
          credential_version INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'HEALTHY',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS connection_secrets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          connection_id UUID NOT NULL,
          version INTEGER NOT NULL,
          encrypted_payload TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT uq_conn_sec_${testSuffix} UNIQUE (connection_id, version)
        );

        CREATE TABLE IF NOT EXISTS migration_runs (
          id UUID PRIMARY KEY,
          workspace_id UUID NOT NULL,
          plan_version_id TEXT,
          status TEXT NOT NULL DEFAULT 'RUNNING',
          source_boundary_json JSONB DEFAULT '{}'::jsonb,
          progress_json JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS migration_batches (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          migration_run_id UUID NOT NULL,
          batch_key TEXT NOT NULL,
          sequence_no INTEGER NOT NULL,
          status TEXT NOT NULL,
          records_read INTEGER DEFAULT 0,
          records_written INTEGER DEFAULT 0,
          records_skipped INTEGER DEFAULT 0,
          records_failed INTEGER DEFAULT 0,
          source_cursor_start JSONB,
          source_cursor_end JSONB,
          error_summary JSONB,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          CONSTRAINT uq_run_batch_${testSuffix} UNIQUE (migration_run_id, batch_key)
        );

        CREATE TABLE IF NOT EXISTS record_manifests (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          migration_run_id UUID NOT NULL,
          source_object TEXT NOT NULL,
          source_key TEXT NOT NULL,
          destination_key TEXT,
          content_hash TEXT,
          status TEXT NOT NULL DEFAULT 'COMMITTED',
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS "${destTable}" (
          id TEXT PRIMARY KEY,
          name TEXT,
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

      // 3. Seed Workspace, Connection, and Encrypted Vault Record
      await testPool.query(
        `INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)`,
        [workspaceId, `E2E Workspace ${testSuffix}`, `e2e-ws-${testSuffix}`],
      );

      await testPool.query(
        `INSERT INTO connections (id, workspace_id, name, engine, connection_role, config_json, credential_version, status)
         VALUES ($1, $2, 'Test Destination PostgreSQL', 'POSTGRESQL', 'DESTINATION', '{}'::jsonb, 1, 'HEALTHY')`,
        [destConnId, workspaceId],
      );

      const secret = encryptVaultSecret({ connectionString: dbUrl }, encryptionKeyHex);
      await testPool.query(
        `INSERT INTO connection_secrets (connection_id, version, encrypted_payload, iv, auth_tag)
         VALUES ($1, 1, $2, $3, $4)`,
        [destConnId, secret.encryptedPayload, secret.iv, secret.authTag],
      );

      await testPool.query(
        `INSERT INTO migration_runs (id, workspace_id, plan_version_id, status)
         VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'RUNNING')`,
        [runId, workspaceId],
      );

      // 4. Create BullMQ Queue Producer
      queue = new Queue(testQueue, {
        connection: {
          host: redisProbe.options.host || 'localhost',
          port: redisProbe.options.port || 6379,
          password: redisProbe.options.password,
          tls: redisProbe.options.tls,
          maxRetriesPerRequest: null,
        },
      });

      // 5. Function to launch a standalone worker process
      const startWorkerProcess = (): Promise<{ child: ChildProcess }> => {
        return new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [workerMainPath], {
            env: {
              ...process.env,
              DATABASE_URL: dbUrl,
              REDIS_URL: redisUrl,
              BULLMQ_QUEUE_NAME: testQueue,
              ENCRYPTION_KEY: encryptionKeyHex,
              ALLOW_SYNTHETIC_SOURCE: 'true',
              RUN_STANDALONE_WORKER: 'true',
              NODE_ENV: 'test',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          let started = false;
          const onData = (data: Buffer) => {
            const str = data.toString();
            if (str.includes('Worker is listening for jobs') || str.includes('Worker pools initialized')) {
              if (!started) {
                started = true;
                resolve({ child });
              }
            }
          };

          child.stdout?.pipe(process.stdout);
          child.stderr?.pipe(process.stderr);
          child.stdout?.on('data', onData);
          child.stderr?.on('data', onData);

          child.on('error', (err) => {
            if (!started) reject(err);
          });

          child.on('exit', (code) => {
            if (!started) reject(new Error(`Worker exited early with code ${code}`));
          });

          // Fallback timeout in case output wasn't matched
          setTimeout(() => {
            if (!started) {
              started = true;
              resolve({ child });
            }
          }, 3500);
        });
      };

      // 6. Launch Worker 1
      const w1 = await startWorkerProcess();
      workerChild1 = w1.child;

      // 7. Dispatch Batch 1 through BullMQ
      const batch1Payload = {
        jobId: `job_${runId}_batch_0001`,
        migrationRunId: runId,
        batchKey: 'batch_customers_0001',
        sequenceNo: 1,
        sourceObject: 'customers',
        destinationObject: destTable,
        destinationConnectionId: destConnId,
        batchSize: 10,
        planVersionId: '00000000-0000-0000-0000-000000000000',
        mappingVersionId: 'map-v1',
        writeMode: 'upsert',
      };

      await queue.add('execute-batch', batch1Payload, {
        jobId: batch1Payload.jobId,
        removeOnComplete: true,
      });

      // 8. Poll for Batch 1 committed state
      let batch1Committed = false;
      const startWait = Date.now();
      while (Date.now() - startWait < 15000) {
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

      // Verify Batch 1 destination records and manifests
      const destCount1 = await testPool.query(`SELECT COUNT(*)::int as count FROM "${destTable}"`);
      expect(destCount1.rows[0].count).toBeGreaterThan(0);

      const manifestCount1 = await testPool.query(
        `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1 AND status = 'COMMITTED'`,
        [runId],
      );
      expect(manifestCount1.rows[0].count).toBe(destCount1.rows[0].count);

      const runRow1 = await testPool.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
        [runId],
      );
      const cp1 = runRow1.rows[0]?.source_boundary_json?.customers;
      expect(cp1).toBeDefined();
      expect(cp1.lastCommittedSequenceNo).toBe(1);
      expect(cp1.committedSequences).toEqual([1]);

      console.log('[Worker Main E2E] Batch 1 processed and committed by live worker process.');

      // 9. Crash Simulation: Kill Worker 1
      workerChild1.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
      workerChild1 = null;

      console.log('[Worker Main E2E] Worker 1 stopped (simulated crash/interruption).');

      // 10. Dispatch Batch 2 while worker is down
      const batch2Payload = {
        jobId: `job_${runId}_batch_0002`,
        migrationRunId: runId,
        batchKey: 'batch_customers_0002',
        sequenceNo: 2,
        sourceObject: 'customers',
        destinationObject: destTable,
        destinationConnectionId: destConnId,
        batchSize: 10,
        cursorStart: { offset: 10 },
        planVersionId: '00000000-0000-0000-0000-000000000000',
        mappingVersionId: 'map-v1',
        writeMode: 'upsert',
      };

      await queue.add('execute-batch', batch2Payload, {
        jobId: batch2Payload.jobId,
        removeOnComplete: true,
      });

      // 11. Start replacement Worker 2
      const w2 = await startWorkerProcess();
      workerChild2 = w2.child;

      // 12. Poll for Batch 2 committed state
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

      const runRow2 = await testPool.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
        [runId],
      );
      const cp2 = runRow2.rows[0]?.source_boundary_json?.customers;
      expect(cp2).toBeDefined();
      expect(cp2.lastCommittedSequenceNo).toBe(2);
      expect(cp2.committedSequences).toEqual([1, 2]);

      const totalRecordsBeforeRedelivery = (
        await testPool.query(`SELECT COUNT(*)::int as count FROM "${destTable}"`)
      ).rows[0].count;

      console.log('[Worker Main E2E] Replacement Worker 2 consumed Batch 2; checkpoint advanced to sequence 2.');

      // 13. Idempotency & Redelivery: Re-deliver Batch 1
      await queue.add('execute-batch', batch1Payload, {
        jobId: `job_${runId}_batch_0001_redelivery`,
        removeOnComplete: true,
      });

      await new Promise((r) => setTimeout(r, 2000));

      // Assert no duplicate records created in destination table
      const totalRecordsAfterRedelivery = (
        await testPool.query(`SELECT COUNT(*)::int as count FROM "${destTable}"`)
      ).rows[0].count;

      expect(totalRecordsAfterRedelivery).toBe(totalRecordsBeforeRedelivery);

      // Checkpoint high-water mark must remain intact at 2
      const runRow3 = await testPool.query(
        `SELECT source_boundary_json FROM migration_runs WHERE id = $1`,
        [runId],
      );
      const cp3 = runRow3.rows[0]?.source_boundary_json?.customers;
      expect(cp3.lastCommittedSequenceNo).toBe(2);

      console.log(
        '[Worker Main E2E Pipeline] Successfully verified end-to-end worker execution, vault resolution, transformation, live PostgreSQL writes, checkpoints, and crash/restart recovery.',
      );
    } finally {
      // Teardown: terminate workers, drain queue, drop test table
      if (workerChild1) {
        workerChild1.kill('SIGTERM');
      }
      if (workerChild2) {
        workerChild2.kill('SIGTERM');
      }
      if (queue) {
        await queue.drain().catch(() => {});
        await queue.obliterate({ force: true }).catch(() => {});
        await queue.close().catch(() => {});
      }
      if (redisProbe) {
        redisProbe.disconnect();
      }
      if (testPool) {
        await testPool.query(`DROP TABLE IF EXISTS "${destTable}" CASCADE`).catch(() => {});
        await testPool.query(`DELETE FROM migration_batches WHERE migration_run_id = $1`, [runId]).catch(() => {});
        await testPool.query(`DELETE FROM record_manifests WHERE migration_run_id = $1`, [runId]).catch(() => {});
        await testPool.query(`DELETE FROM migration_runs WHERE id = $1`, [runId]).catch(() => {});
        await testPool.query(`DELETE FROM connection_secrets WHERE connection_id = $1`, [destConnId]).catch(() => {});
        await testPool.query(`DELETE FROM connections WHERE id = $1`, [destConnId]).catch(() => {});
        await testPool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => {});
        await testPool.end().catch(() => {});
      }
    }
  });
});

