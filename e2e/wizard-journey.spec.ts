import { test, expect } from '@playwright/test';
import { ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  validateSafeTestDatabaseEndpoint,
  validateSafeTestMongoEndpoint,
  validateSafeTestRedisEndpoint,
} from '../packages/worker/test/helpers/postgres-test-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'packages', 'backend');
const WORKER_DIR = path.join(REPO_ROOT, 'packages', 'worker');
const FRONTEND_DIR = path.join(REPO_ROOT, 'packages', 'frontend');
const backendRequire = createRequire(path.join(BACKEND_DIR, 'package.json'));
const frontRequire = createRequire(path.join(FRONTEND_DIR, 'package.json'));
const pg = backendRequire('pg');
const { MongoClient } = backendRequire('mongodb');

async function isTcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const finish = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

async function waitForHttpReady(url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for HTTP endpoint: ${url}`);
}

async function apiJson(baseUrl: string, p: string, method: string, body?: any, token?: string) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) {
    throw new Error(`API ${method} ${p} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.data !== undefined ? json.data : json;
}

function buildDestDbUrl(controlPlaneUrl: string, dbName: string): string {
  const u = new URL(controlPlaneUrl);
  u.pathname = `/${dbName}`;
  u.search = '?schema=public';
  return u.toString();
}

test.describe('Tier 5 Browser E2E: Complete 14-Step Live Wizard Journey & Report Downloads', () => {
  const isCi = process.env.CI === 'true';
  const suffix = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const mongoDbName = `mg_pw_src_${suffix}`;
  const destDbName = `mg_pw_dest_${suffix}`;
  const bullQueueName = `mg_pw_exec_${suffix}`;
  const reportsDir = path.join(os.tmpdir(), `mg-pw-reports-${suffix}`);

  const controlDbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL;
  const mongoUrl =
    process.env.MIGRATIONGUARD_TEST_MONGO_URL ||
    process.env.TEST_MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URL;
  const redisUrl =
    process.env.MIGRATIONGUARD_TEST_REDIS_URL ||
    process.env.TEST_REDIS_URL ||
    process.env.REDIS_URL ||
    'redis://127.0.0.1:6379';

  let backendProc: ChildProcess | null = null;
  let workerProc: ChildProcess | null = null;
  let frontendProc: ChildProcess | null = null;
  let adminPool: any = null;
  let destPool: any = null;
  let mongoClient: any = null;
  let createdWorkspaceId: string | null = null;
  let canRunFullStack = true;
  let skipReason = '';

  test.beforeAll(async () => {
    if (!controlDbUrl || !mongoUrl) {
      skipReason = 'MIGRATIONGUARD_TEST_DATABASE_URL and MIGRATIONGUARD_TEST_MONGO_URL required for full-stack E2E.';
      if (isCi) throw new Error(`[CI Mandatory Failure] ${skipReason}`);
      canRunFullStack = false;
      return;
    }

    validateSafeTestDatabaseEndpoint(controlDbUrl);
    validateSafeTestMongoEndpoint(mongoUrl);
    validateSafeTestRedisEndpoint(redisUrl);

    const rParsed = new URL(redisUrl);
    const redisReachable = await isTcpReachable(rParsed.hostname, Number(rParsed.port || 6379));
    if (!redisReachable) {
      skipReason = `Redis unavailable at ${rParsed.hostname}:${rParsed.port || 6379}`;
      if (isCi) throw new Error(`[CI Mandatory Failure] ${skipReason}`);
      canRunFullStack = false;
      return;
    }

    const backendEntry = path.join(BACKEND_DIR, 'dist', 'main.js');
    const workerEntry = path.join(WORKER_DIR, 'dist', 'worker-main.js');
    const frontendBuildId = path.join(FRONTEND_DIR, '.next', 'BUILD_ID');
    if (!fs.existsSync(backendEntry) || !fs.existsSync(workerEntry) || !fs.existsSync(frontendBuildId)) {
      throw new Error('Backend, Worker, and Frontend Next.js builds are required before Playwright E2E.');
    }

    fs.mkdirSync(reportsDir, { recursive: true });

    // 1. Setup ephemeral source MongoDB documents & destination PostgreSQL database
    mongoClient = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 5000 });
    await mongoClient.connect();
    const srcColl = mongoClient.db(mongoDbName).collection('customers');
    await srcColl.deleteMany({});
    await srcColl.insertMany([
      { _id: 'pw_cust_1', name: '  Alice Johnson  ', email: 'ALICE@EXAMPLE.COM', phone: '+1-555-0001', tier: 'ENTERPRISE', status: 'ACTIVE', createdAt: '2026-11-20T10:00:00.000Z', metadata: { city: 'SF' } },
      { _id: 'pw_cust_2', name: '  Bob Smith  ', email: 'BOB@EXAMPLE.COM', phone: '+1-555-0002', tier: 'STANDARD', status: 'ACTIVE', createdAt: '2026-11-20T10:05:00.000Z', metadata: { city: 'NYC' } },
      { _id: 'pw_cust_3', name: '  Carol White  ', email: 'CAROL@EXAMPLE.COM', phone: '+1-555-0003', tier: 'STANDARD', status: 'ACTIVE', createdAt: '2026-11-20T10:10:00.000Z', metadata: { city: 'LA' } },
      { _id: 'pw_cust_4', name: '  Dave Brown  ', email: 'DAVE@EXAMPLE.COM', phone: '+1-555-0004', tier: 'ENTERPRISE', status: 'ACTIVE', createdAt: '2026-11-20T10:15:00.000Z', metadata: { city: 'SEA' } },
      { _id: 'pw_cust_5', name: '  Eve Davis  ', email: 'EVE@EXAMPLE.COM', phone: '+1-555-0005', tier: 'STANDARD', status: 'ACTIVE', createdAt: '2026-11-20T10:20:00.000Z', metadata: { city: 'ATX' } },
    ]);

    const adminUrl = new URL(controlDbUrl);
    adminPool = new pg.Pool({ connectionString: controlDbUrl });
    await adminPool.query(`CREATE DATABASE "${destDbName}"`);
    const destDbUrl = buildDestDbUrl(controlDbUrl, destDbName);
    destPool = new pg.Pool({ connectionString: destDbUrl });
    await destPool.query(`
      CREATE TABLE IF NOT EXISTS customers (
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
    await destPool.end();
    destPool = new pg.Pool({ connectionString: destDbUrl });

    const sharedEnv = {
      ...process.env,
      NODE_ENV: 'test',
      ALLOW_IN_MEMORY_DB: 'false',
      ALLOW_SYNTHETIC_SOURCE: 'false',
      FORCE_POSTGRES_DB: 'true',
      ALLOW_DEV_JWT: 'true',
      AI_ENABLED: 'false',
      DATABASE_URL: controlDbUrl,
      REDIS_URL: redisUrl,
      REDIS_HOST: rParsed.hostname,
      REDIS_PORT: String(rParsed.port || 6379),
      ENCRYPTION_KEY:
        process.env.ENCRYPTION_KEY ||
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      JWT_SECRET:
        process.env.JWT_SECRET ||
        'migrationguard_super_secure_jwt_dev_secret_key_minimum_32_chars!',
      BULLMQ_QUEUE_NAME: bullQueueName,
      REPORTS_STORAGE_DIR: reportsDir,
    };

    backendProc = spawn(process.execPath, [backendEntry], {
      cwd: BACKEND_DIR,
      env: { ...sharedEnv, PORT: '4000', CORS_ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000' },
      stdio: 'pipe',
    });
    await waitForHttpReady('http://127.0.0.1:4000/health/liveness', 45_000);

    workerProc = spawn(process.execPath, [workerEntry], {
      cwd: WORKER_DIR,
      env: sharedEnv,
      stdio: 'pipe',
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker failed to emit ready log within 30s')), 30_000);
      workerProc!.stdout?.on('data', (chunk) => {
        if (chunk.toString().includes('Worker is listening for jobs')) {
          clearTimeout(timer);
          resolve();
        }
      });
      workerProc!.stderr?.on('data', () => {});
    });

    const nextBin = frontRequire.resolve('next/dist/bin/next', { paths: [FRONTEND_DIR, REPO_ROOT] });
    frontendProc = spawn(process.execPath, [nextBin, 'start', '-p', '3000', '-H', 'localhost'], {
      cwd: FRONTEND_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_PUBLIC_DEMO_MODE: 'false',
        NEXT_PUBLIC_API_URL: 'http://localhost:4000/api/v1',
      },
      stdio: 'pipe',
    });
    await waitForHttpReady('http://localhost:3000/wizard', 45_000);

    void adminUrl;
  });

  test.afterAll(async () => {
    for (const p of [frontendProc, workerProc, backendProc]) {
      if (p && !p.killed) {
        p.kill('SIGTERM');
      }
    }
    if (destPool) await destPool.end().catch(() => {});
    if (adminPool) {
      if (createdWorkspaceId) {
        await adminPool.query(`DELETE FROM workspaces WHERE id = $1`, [createdWorkspaceId]).catch(() => {});
      }
      await adminPool.query(`DROP DATABASE IF EXISTS "${destDbName}" WITH (FORCE)`).catch(async () => {
        await adminPool!.query(`DROP DATABASE IF EXISTS "${destDbName}"`).catch(() => {});
      });
      await adminPool.end().catch(() => {});
    }
    if (mongoClient) {
      await mongoClient.db(mongoDbName).dropDatabase().catch(() => {});
      await mongoClient.close().catch(() => {});
    }
    fs.rmSync(reportsDir, { recursive: true, force: true });
  });

  test('completes full live 14-step Wizard click-through and downloads real HTML & CSV assurance reports', async ({
    page,
  }) => {
    test.skip(!canRunFullStack, skipReason);

    const apiBase = 'http://localhost:4000/api/v1';
    const reg = await apiJson(apiBase, '/auth/register', 'POST', {
      email: `pw-op-${suffix}@migrationguard.io`,
      name: 'Playwright Operator',
      password: 'Password123!',
    });
    const token = reg.accessToken || reg.access_token;
    createdWorkspaceId = reg.workspace.id;

    const proj = await apiJson(
      apiBase,
      `/workspaces/${createdWorkspaceId}/projects`,
      'POST',
      { name: 'Playwright E2E Project', description: 'Live 14-step test' },
      token,
    );
    const destDbUrl = buildDestDbUrl(controlDbUrl!, destDbName);

    const srcConn = await apiJson(
      apiBase,
      `/workspaces/${createdWorkspaceId}/connections`,
      'POST',
      {
        name: 'Playwright Mongo Source',
        engine: 'MONGODB',
        connectionRole: 'SOURCE',
        config: { host: 'localhost', port: 27017, database: mongoDbName },
        credentials: { uri: mongoUrl },
      },
      token,
    );
    const dstConn = await apiJson(
      apiBase,
      `/workspaces/${createdWorkspaceId}/connections`,
      'POST',
      {
        name: 'Playwright PG Target',
        engine: 'POSTGRESQL',
        connectionRole: 'DESTINATION',
        config: { host: 'localhost', port: 5432, database: destDbName, schema: 'public' },
        credentials: { connectionString: destDbUrl },
      },
      token,
    );

    await apiJson(apiBase, `/connections/${srcConn.id}/schema-discovery`, 'POST', {}, token);
    await apiJson(apiBase, `/connections/${dstConn.id}/schema-discovery`, 'POST', {}, token);

    await page.addInitScript((authToken) => {
      window.localStorage.setItem('mg_auth_token', authToken);
      window.localStorage.setItem('mg_demo_mode', 'false');
    }, token);

    await page.goto('http://localhost:3000/wizard');
    await expect(page.getByText('[LIVE PRODUCTION MODE]')).toBeVisible();
    await expect(page.getByText('Playwright Mongo Source')).toBeVisible();

    // Step 1 -> Step 2 -> Step 3
    await page.getByRole('button', { name: 'Next Step' }).click();
    await expect(page.getByText('Playwright PG Target')).toBeVisible();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 3: Live dual handshake probe
    await expect(page.getByText('200 OK • Read/Extract Authorized')).toBeVisible();
    await expect(page.getByText('200 OK • Upsert/DDL Permissions Active')).toBeVisible();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 4 & 5: Source & Destination live snapshots
    await expect(page.getByText('Collection: customers')).toBeVisible();
    await page.getByRole('button', { name: 'Next Step' }).click();
    await expect(page.getByText('Table: customers')).toBeVisible();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 6: AI Mapping Recommendations
    await page.getByRole('button', { name: /Synthesize AI Mappings/i }).click();
    await expect(page.getByText('Synthesized Proposal (Live AI Agent):')).toBeVisible();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 7: Edit DSL, persist mapping version & validate
    const mappingArea = page.locator('textarea').first();
    const updatedDsl = {
      version: 1,
      objects: [
        {
          source: { collection: 'customers' },
          destination: { schema: 'public', table: 'customers' },
          identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
          fields: [
            { sourcePath: '_id', destinationPath: 'id', transform: { op: 'PRESERVE_SOURCE_ID' } },
            { sourcePath: 'name', destinationPath: 'name', transform: { op: 'TRIM_STRING' } },
            { sourcePath: 'email', destinationPath: 'email', transform: { op: 'LOWERCASE' } },
            { sourcePath: 'createdAt', destinationPath: 'created_at', transform: { op: 'PARSE_TIMESTAMP' } },
            { sourcePath: 'metadata', destinationPath: 'metadata', transform: { op: 'TO_JSONB' } },
          ],
        },
      ],
    };
    await mappingArea.fill(JSON.stringify(updatedDsl, null, 2));
    await page.getByRole('button', { name: 'Save New Version' }).click();
    await expect(page.getByText('DSL Validation: PASS (0 blocking issues)')).toBeVisible();
    await page.getByRole('button', { name: 'Validate DSL' }).click();
    await expect(page.getByText('DSL Validation: PASS (0 blocking issues)')).toBeVisible();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 8: Sample Transform Preview Drawer
    await page.getByRole('button', { name: 'Execute Backend Transform Preview' }).click();
    await expect(page.getByText('Deterministic Transform Sample Preview')).toBeVisible();
    await expect(page.getByText('Destination (PostgreSQL Row)')).toBeVisible();
    await page.getByRole('button', { name: 'Close drawer' }).click();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 9: Persist Plan Version
    await page.getByRole('button', { name: /Create & Persist Plan Version/i }).click();
    await expect(page.getByRole('button', { name: 'Persisted Plan Version Active' })).toBeVisible();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 10: Fail-Closed Dry Run
    await page.getByRole('button', { name: 'Trigger Live Dry Run' }).click();
    await expect(page.getByText('Dry Run Passed (100% Verified)')).toBeVisible();
    await expect(page.getByText('5 docs').first()).toBeVisible();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 11: Cryptographic Approval Modal
    await page.getByRole('button', { name: 'Review & Sign Plan Approval' }).click();
    await page.locator('#hash-confirm').check();
    await page.getByRole('button', { name: 'Approve Plan Hash' }).click();

    // Step 12: Live Migration Run dispatched via Worker
    await expect(page.getByText('Step 12: Migration Execution & Streaming Monitor')).toBeVisible();
    await page.getByRole('button', { name: 'Start Migration Run' }).click();
    await expect(page.locator('span', { hasText: /^COMPLETED$/ }).first()).toBeVisible({ timeout: 35_000 });
    await expect(page.getByText('100% Complete')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 13: Trigger real backend validation & verify 0 discrepancies loaded cleanly
    await page.getByRole('button', { name: 'Trigger Validation' }).click();
    await expect(page.getByText('Validation Run Status:')).toBeVisible();
    await expect(page.locator('span', { hasText: /^PASSED$/ }).first()).toBeVisible({ timeout: 20_000 });
    for (const label of ['Missing Attachments', 'Duplicate Records', 'Broken References', 'Metadata Mismatches']) {
      const card = page.locator('div.p-2').filter({ hasText: label });
      await expect(card.locator('span').first()).toHaveText('0');
    }
    await expect(page.getByRole('button', { name: 'Next Step' })).toBeEnabled();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 14: Download genuine HTML & CSV assurance reports from backend
    const [htmlDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download Executive HTML Report' }).click(),
    ]);
    expect(htmlDownload.suggestedFilename()).toMatch(/\.html$/i);
    const htmlPath = await htmlDownload.path();
    const htmlContent = fs.readFileSync(htmlPath!, 'utf8');
    expect(htmlContent).toContain('MigrationGuard Assurance Report');
    expect(htmlContent).toContain('COUNT_MISMATCH_customers');

    const [csvDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export Detailed Discrepancies CSV' }).click(),
    ]);
    expect(csvDownload.suggestedFilename()).toMatch(/\.csv$/i);
    const csvPath = await csvDownload.path();
    const csvContent = fs.readFileSync(csvPath!, 'utf8');
    expect(csvContent).toContain('# MigrationGuard Validation Assurance Report');
    expect(csvContent).toContain('COUNT_MISMATCH_customers');

    // Verify migrated rows directly in destination PostgreSQL table
    const destRows = await destPool!.query(`SELECT id, name, email FROM customers ORDER BY id ASC`);
    expect(destRows.rows).toHaveLength(5);
    expect(destRows.rows[0]).toMatchObject({
      id: 'pw_cust_1',
      name: 'Alice Johnson',
      email: 'alice@example.com',
    });

    void proj;
  });
});
