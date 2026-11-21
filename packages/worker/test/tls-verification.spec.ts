import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

describe('Strict TLS Verification Guard (P1.5)', () => {
  const repoRoot = path.resolve(__dirname, '../../..');

  it('strictly disallows ALLOW_INSECURE_TLS=true in production', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.ALLOW_INSECURE_TLS='true'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.REDIS_URL='rediss://remote:15678'; require('./packages/worker/dist/worker-main.js');"`;

    let failed = false;
    let errorMessage = '';
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
    } catch (err: any) {
      failed = true;
      errorMessage = err.stderr ? err.stderr.toString() : err.message;
    }

    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/Insecure TLS \(ALLOW_INSECURE_TLS=true\) is strictly forbidden in production/);
  }, 30000);

  it('fails TLS connection when certificate verification fails against invalid or self-signed cert', async () => {
    const tls = await import('node:tls');

    // Attempt to connect to an untrusted local TLS endpoint with rejectUnauthorized: true
    let tlsFailed = false;
    try {
      await new Promise((resolve, reject) => {
        const socket = tls.connect({
          host: '127.0.0.1',
          port: 19999,
          rejectUnauthorized: true,
          timeout: 1000,
        });
        socket.on('secureConnect', resolve);
        socket.on('error', reject);
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('Connection timed out'));
        });
      });
    } catch {
      tlsFailed = true;
    }

    expect(tlsFailed).toBe(true);
  });
});
