import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

describe('Backend Configuration Fail-Closed Security (P0.3)', () => {
  const repoRoot = path.resolve(__dirname, '../../..');

  it('fails startup in production when JWT_SECRET is missing or empty', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.JWT_SECRET=''; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; require('./packages/backend/dist/config/configuration.js');"`;

    let failed = false;
    let errorMessage = '';
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
    } catch (err: any) {
      failed = true;
      errorMessage = err.stderr ? err.stderr.toString() : err.message;
    }

    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/JWT_SECRET must be explicitly set to a strong secret/);
  });

  it('fails startup in production when JWT_SECRET uses known insecure placeholder', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.JWT_SECRET='migrationguard_super_secure_jwt_dev_secret_key_minimum_32_chars!'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; require('./packages/backend/dist/config/configuration.js');"`;

    let failed = false;
    let errorMessage = '';
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
    } catch (err: any) {
      failed = true;
      errorMessage = err.stderr ? err.stderr.toString() : err.message;
    }

    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/Known development placeholders are strictly forbidden/);
  });

  it('fails startup in production when DATABASE_URL points to localhost', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.JWT_SECRET='strong_production_secret_key_greater_than_32_characters_long!'; process.env.DATABASE_URL='postgresql://postgres:pass@localhost:5432/db'; process.env.ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; require('./packages/backend/dist/config/configuration.js');"`;

    let failed = false;
    let errorMessage = '';
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
    } catch (err: any) {
      failed = true;
      errorMessage = err.stderr ? err.stderr.toString() : err.message;
    }

    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost/);
  });

  it('fails startup when ENCRYPTION_KEY is missing or empty', () => {
    const cmd = `node -e "process.env.ENCRYPTION_KEY=''; process.env.ENCRYPTION_MASTER_KEY=''; require('./packages/backend/dist/config/configuration.js');"`;

    let failed = false;
    let errorMessage = '';
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
    } catch (err: any) {
      failed = true;
      errorMessage = err.stderr ? err.stderr.toString() : err.message;
    }

    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/ENCRYPTION_KEY \(or ENCRYPTION_MASTER_KEY\) is not set/);
  });

  it('fails startup in production when ALLOW_INSECURE_TLS is true', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.ALLOW_INSECURE_TLS='true'; process.env.JWT_SECRET='strong_production_secret_key_greater_than_32_characters_long!'; process.env.DATABASE_URL='postgresql://user:pass@remote:5432/db'; process.env.ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; require('./packages/backend/dist/config/configuration.js');"`;

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
  });

  it('fails startup in production when DATABASE_URL points to IPv6 loopback [::1]', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.JWT_SECRET='strong_production_secret_key_greater_than_32_characters_long!'; process.env.DATABASE_URL='postgresql://postgres:pass@[::1]:5432/db'; process.env.ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; require('./packages/backend/dist/config/configuration.js');"`;

    let failed = false;
    let errorMessage = '';
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
    } catch (err: any) {
      failed = true;
      errorMessage = err.stderr ? err.stderr.toString() : err.message;
    }

    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/DATABASE_URL must be explicitly configured and cannot use localhost or loopback/);
  });

  it('fails startup in production when database is unreachable even if ALLOW_IN_MEMORY_DB is true', () => {
    const cmd = `node -e "process.env.NODE_ENV='production'; process.env.ALLOW_IN_MEMORY_DB='true'; process.env.JWT_SECRET='strong_production_secret_key_greater_than_32_characters_long!'; process.env.ENCRYPTION_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; process.env.DATABASE_URL='postgresql://user:pass@nonexistent-db.invalid:5432/db'; const { DatabaseService } = require('./packages/backend/dist/database/database.service.js'); const db = new DatabaseService(); db.onModuleInit().catch(err => { console.error(err.message); process.exit(1); });"`;

    let failed = false;
    let errorMessage = '';
    try {
      execSync(cmd, { cwd: repoRoot, stdio: 'pipe', timeout: 15000 });
    } catch (err: any) {
      failed = true;
      errorMessage = err.stderr ? err.stderr.toString() : err.message;
    }

    expect(failed).toBe(true);
    expect(errorMessage).toMatch(/PostgreSQL connection is strictly required in production/);
  });
});
