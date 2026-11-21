import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

describe('Worker Configuration Fail-Closed Security (P1)', () => {
  const repoRoot = path.resolve(__dirname, '../../..');

  it('fails startup in production when DATABASE_URL is missing or empty', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL=''; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;

    let failed = false;
    let errorMessage = '';
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe', timeout: 5000 });
    } catch (err: any) {
      failed = true;
      errorMessage = err.stderr ? err.stderr.toString() : err.message;
    }

    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost/);
  });

  it('fails startup in production when DATABASE_URL points to localhost', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://postgres:pass@localhost:5432/db'; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;

    let failed = false;
    let errorMessage = '';
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe', timeout: 5000 });
    } catch (err: any) {
      failed = true;
      errorMessage = err.stderr ? err.stderr.toString() : err.message;
    }

    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost/);
  });

  it('fails startup in production when REDIS_URL and remote REDIS_HOST are missing', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL=''; process.env.REDIS_HOST='localhost'; require('./packages/worker/dist/worker-main.js');"`;

    let failed = false;
    let errorMessage = '';
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe', timeout: 5000 });
    } catch (err: any) {
      failed = true;
      errorMessage = err.stderr ? err.stderr.toString() : err.message;
    }

    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL or remote REDIS_HOST must be explicitly configured/);
  });
});
