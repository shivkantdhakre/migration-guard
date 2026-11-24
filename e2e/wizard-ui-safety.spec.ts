import { test, expect } from '@playwright/test';
import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(REPO_ROOT, 'packages', 'frontend');

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttpReady(url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // retry until ready
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

test.describe('Wizard Browser UI Safety: Stepper Gating & Step 13 Discrepancy Error Handling', () => {
  let frontendProc: ChildProcess | null = null;
  let baseUrl = '';

  test.beforeAll(async () => {
    const buildIdPath = path.join(FRONTEND_DIR, '.next', 'BUILD_ID');
    if (!fs.existsSync(buildIdPath)) {
      throw new Error(
        `Frontend production build missing (${buildIdPath}). Run 'pnpm --filter @migrationguard/frontend run build:next' first.`,
      );
    }

    const port = await getFreePort();
    const nextBin = require.resolve('next/dist/bin/next', { paths: [FRONTEND_DIR, REPO_ROOT] });

    frontendProc = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: FRONTEND_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_PUBLIC_DEMO_MODE: 'false',
      },
      stdio: 'pipe',
    });

    baseUrl = `http://127.0.0.1:${port}`;
    await waitForHttpReady(`${baseUrl}/wizard`);
  });

  test.afterAll(async () => {
    if (frontendProc && !frontendProc.killed) {
      frontendProc.kill('SIGTERM');
    }
  });

  test('blocks top stepper jumps without handshakes and withholds zero counts when Step 13 discrepancies fetch fails', async ({
    page,
  }) => {
    let discrepancyCallCount = 0;
    let shouldFailDiscrepancyFetch = true;

    const apiPrefix = '**/api/v1/**';
    await page.route(apiPrefix, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const p = url.pathname.replace(/^\/api\/v1/, '');

      if (p === '/me') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { id: 'user-1', email: 'op@test.io', workspaces: [{ workspace_id: 'ws-1', id: 'ws-1' }] },
          }),
        });
      }
      if (p === '/workspaces/ws-1/projects') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [{ id: 'proj-1', name: 'Test Project' }] }),
        });
      }
      if (p === '/workspaces/ws-1/connections') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [
              { id: 'conn-src', name: 'Src Mongo', engine: 'MONGODB', connectionRole: 'SOURCE', config: { host: 'localhost', port: 27017, database: 'src' } },
              { id: 'conn-dst', name: 'Dst PG', engine: 'POSTGRESQL', connectionRole: 'DESTINATION', config: { host: 'localhost', port: 5432, database: 'dst' } },
            ],
          }),
        });
      }
      if (p === '/projects/proj-1/plans') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [
              {
                id: 'plan-1',
                name: 'Plan 1',
                status: 'DRAFT',
                versionId: 'pv-1',
                planHash: 'sha256:testplanhash',
                versions: [{ id: 'pv-1', version: 1, planHash: 'sha256:testplanhash', status: 'DRAFT' }],
              },
            ],
          }),
        });
      }
      if (p === '/projects/proj-1/mappings') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: [
              {
                id: 'mv-1',
                version: 1,
                mapping_json: {
                  version: 1,
                  objects: [{ source: { collection: 'customers' }, destination: { table: 'customers' }, identity: { sourceKey: '_id', destinationKey: 'id' }, fields: [] }],
                },
              },
            ],
          }),
        });
      }
      if (p.endsWith('/schema-snapshots')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
      }
      if (p === '/connections/conn-src/test' || p === '/connections/conn-dst/test') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { success: true, latencyMs: 5, message: 'OK' } }),
        });
      }
      if (p === '/plan-versions/pv-1/dry-runs') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              dryRunId: 'dry-1',
              status: 'COMPLETED',
              readyForApproval: true,
              planHash: 'sha256:testplanhash',
              sampleRecordsTested: 5,
              recordsTransformed: 5,
              transformationErrors: 0,
              potentialTypeConflicts: [],
              measuredFacts: {
                sampleRecordsTested: 5,
                recordsTransformed: 5,
                transformationErrors: 0,
                measuredDurationMs: 12,
              },
            },
          }),
        });
      }
      if (p === '/plan-versions/pv-1/approvals') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { approved: true, hash: 'sha256:testplanhash' } }),
        });
      }
      if (p === '/migration-runs') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { runId: 'run-1', status: 'COMPLETED', planHash: 'sha256:testplanhash' } }),
        });
      }
      if (p === '/migration-runs/run-1') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { id: 'run-1', status: 'COMPLETED' } }),
        });
      }
      if (p === '/migration-runs/run-1/progress') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { runId: 'run-1', status: 'COMPLETED', recordsPerSecond: 100, percentageComplete: 100 } }),
        });
      }
      if (p === '/migration-runs/run-1/batches') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { batches: [{ id: 'b-1', batchIndex: 1, recordsCount: 5 }] } }),
        });
      }
      if (p === '/migration-runs/run-1/validations' && req.method() === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { id: 'val-1', status: 'PASSED' } }),
        });
      }
      if (p === '/validation-runs/val-1/discrepancies') {
        discrepancyCallCount++;
        if (shouldFailDiscrepancyFetch) {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Simulated discrepancy store outage' }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { discrepancies: [] } }),
        });
      }
      if (p === '/validation-runs/val-1/checks') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
      }

      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: `Unmocked ${p}` }) });
    });

    await page.addInitScript(() => {
      window.localStorage.setItem('mg_auth_token', 'test-jwt-token');
      window.localStorage.setItem('mg_demo_mode', 'false');
    });

    await page.goto(`${baseUrl}/wizard`);
    await expect(page.getByText('[LIVE PRODUCTION MODE]')).toBeVisible();

    // Verify top stepper bar strictly blocks skipping Step 3 handshake before Step 3 runs
    const step4Btn = page.getByRole('button', { name: /4\s*Source Schema/i });
    const step13Btn = page.getByRole('button', { name: /13\s*Validation/i });
    const step14Btn = page.getByRole('button', { name: /14\s*Export Reports/i });
    await expect(step4Btn).toBeDisabled();
    await expect(step13Btn).toBeDisabled();
    await expect(step14Btn).toBeDisabled();

    // Advance Steps 1 -> 2 -> 3
    await page.getByRole('button', { name: 'Next Step' }).click();
    await page.getByRole('button', { name: 'Next Step' }).click();
    await expect(page.getByText('200 OK • Read/Extract Authorized')).toBeVisible();
    await expect(step4Btn).toBeEnabled();

    // Advance cleanly through Step 10 Dry Run
    for (let s = 3; s <= 9; s++) {
      await page.getByRole('button', { name: 'Next Step' }).click();
    }
    await expect(page.getByRole('button', { name: 'Next Step' })).toBeDisabled();
    await page.getByRole('button', { name: /Trigger Live Dry Run/i }).click();
    await expect(page.getByText('Dry Run Passed (100% Verified)')).toBeVisible();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 11 Approval
    await page.getByRole('button', { name: 'Review & Sign Plan Approval' }).click();
    await page.locator('#hash-confirm').check();
    await page.getByRole('button', { name: 'Approve Plan Hash' }).click();

    // Step 12 Migration Execution (COMPLETED)
    await page.getByRole('button', { name: 'Start Migration Run' }).click();
    await expect(page.getByText('100% Complete')).toBeVisible();
    await expect(step13Btn).toBeEnabled();
    await page.getByRole('button', { name: 'Next Step' }).click();

    // Step 13: Trigger validation while discrepancy fetch returns HTTP 500
    await page.getByRole('button', { name: 'Trigger Validation' }).click();
    await expect(page.getByText('Failed to fetch discrepancy metrics')).toBeVisible();
    await expect(step14Btn).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Next Step' })).toBeDisabled();

    // Every discrepancy category card MUST display '—', NEVER '0'
    for (const label of ['Missing Attachments', 'Duplicate Records', 'Broken References', 'Metadata Mismatches']) {
      const card = page.locator('div.p-2').filter({ hasText: label });
      await expect(card.locator('span').first()).toHaveText('—');
    }

    // Retry fetch once backend recovers -> displays '0' and unlocks Step 14
    shouldFailDiscrepancyFetch = false;
    await page.getByRole('button', { name: 'Retry Fetching Discrepancies' }).click();
    await expect.poll(() => discrepancyCallCount).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('Failed to fetch discrepancy metrics')).toHaveCount(0);
    for (const label of ['Missing Attachments', 'Duplicate Records', 'Broken References', 'Metadata Mismatches']) {
      const card = page.locator('div.p-2').filter({ hasText: label });
      await expect(card.locator('span').first()).toHaveText('0');
    }
    await expect(step14Btn).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Next Step' })).toBeEnabled();
  });
});
