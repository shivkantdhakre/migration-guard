import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

describe('Worker Configuration Fail-Closed Security (P1 & Run 005.1)', { timeout: 15000 }, () => {
  const repoRoot = path.resolve(__dirname, '../../..');

  const runNodeCmd = (cmd: string): { failed: boolean; errorMessage: string } => {
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe', timeout: 10000 });
      return { failed: false, errorMessage: '' };
    } catch (err: any) {
      const stderr = err.stderr ? err.stderr.toString() : '';
      const stdout = err.stdout ? err.stdout.toString() : '';
      return { failed: true, errorMessage: stderr || stdout || err.message };
    }
  };

  it('fails startup in production when DATABASE_URL is missing or empty', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL=''; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost/);
  });

  it('fails startup in production when DATABASE_URL points to localhost', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://postgres:pass@localhost:5432/db'; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost or loopback/);
  });

  it('fails startup in production when DATABASE_URL points to IPv6 loopback [::1]', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://postgres:pass@[::1]:5432/db'; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost or loopback/);
  });

  it('fails startup in production when ALLOW_SYNTHETIC_SOURCE is true', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.ALLOW_SYNTHETIC_SOURCE='true'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/Synthetic source execution \(ALLOW_SYNTHETIC_SOURCE=true\) is strictly forbidden in production/);
  });

  it('fails startup in production when REDIS_URL and remote REDIS_HOST are missing', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL=''; process.env.REDIS_HOST='localhost'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL or remote non-loopback REDIS_HOST must be explicitly configured/);
  });

  it('fails startup in production when REDIS_URL points to localhost', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://localhost:6379'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL cannot point to loopback\/localhost/);
  });

  it('fails startup in production when REDIS_URL points to 127.0.0.1', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://127.0.0.1:6379'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL cannot point to loopback\/localhost/);
  });

  it('fails startup in production when REDIS_URL points to IPv6 loopback [::1]', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://[::1]:6379'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL cannot point to loopback\/localhost/);
  });

  it('fails startup in production when REDIS_URL does not use TLS (rediss://)', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='redis://valkey.cloud.provider:15678'; require('./packages/worker/dist/worker-main.js');"`;
    const { failed, errorMessage } = runNodeCmd(cmd);
    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/REDIS_URL must use TLS \('rediss:\/\/'\)/);
  });
});
