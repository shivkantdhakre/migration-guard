import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../src/database/database.service';
import { validateSafeTestDatabaseEndpoint } from './redis-test-utils';

describe('Manifest Schema Upgrade & Historical Reconciliation (Run 005.15 & P1)', () => {
  let dbService: DatabaseService;
  let rawPool: pg.Pool;
  const isCi = process.env.CI === 'true';
  const initialEnv = { ...process.env };

  const targetDbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;

  const testSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const workspaceId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const planVersionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const sourceConnId = crypto.randomUUID();
  const destConnId = crypto.randomUUID();

  beforeAll(async () => {
    if (!targetDbUrl) {
      if (isCi) {
        throw new Error(
          '[CI Mandatory Failure] MIGRATIONGUARD_TEST_DATABASE_URL or TEST_DATABASE_URL must be configured in CI.',
        );
      }
      console.warn('[Safety Guard] No designated test database URL provided. Skipping upgrade test.');
      return;
    }

    try {
      validateSafeTestDatabaseEndpoint(targetDbUrl);
    } catch (err: any) {
      if (isCi) throw new Error(`[CI Mandatory Failure] ${err.message}`);
      console.warn(err.message);
      return;
    }

    process.env.ALLOW_IN_MEMORY_DB = 'false';
    process.env.FORCE_POSTGRES_DB = 'true';

    rawPool = new pg.Pool({ connectionString: targetDbUrl, max: 5 });
    dbService = new DatabaseService(targetDbUrl);
    await dbService.onModuleInit();

    // Ensure baseline schema is present
    const schemaPath = path.resolve(__dirname, '../src/database/schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      await rawPool.query(sql);
    }

    // Seed canonical relational fixtures
    await rawPool.query(
      `INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)`,
      [workspaceId, `Upgrade Test Workspace ${testSuffix}`, `ws-upg-${testSuffix}`],
    );

    await rawPool.query(
      `INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, 'Upgrade Project')`,
      [projectId, workspaceId],
    );

    await rawPool.query(
      `INSERT INTO connections (id, workspace_id, name, engine, connection_role, status)
       VALUES ($1, $2, 'Src', 'MONGODB', 'SOURCE', 'HEALTHY'),
              ($3, $2, 'Dst', 'POSTGRESQL', 'DESTINATION', 'HEALTHY')`,
      [sourceConnId, workspaceId, destConnId],
    );

    await rawPool.query(
      `INSERT INTO migration_plans (id, workspace_id, project_id, name) VALUES ($1, $2, $3, 'Plan')`,
      [planId, workspaceId, projectId],
    );

    await rawPool.query(
      `INSERT INTO migration_plan_versions (id, plan_id, source_connection_id, destination_connection_id, plan_hash)
       VALUES ($1, $2, $3, $4, 'hash_upg_001')`,
      [planVersionId, planId, sourceConnId, destConnId],
    );

    await rawPool.query(
      `INSERT INTO migration_runs (id, workspace_id, project_id, plan_version_id, status)
       VALUES ($1, $2, $3, $4, 'RUNNING')`,
      [runId, workspaceId, projectId, planVersionId],
    );

    await rawPool.query(
      `INSERT INTO migration_batches (id, migration_run_id, batch_key, sequence_no, status)
       VALUES ($1, $2, 'batch_upg_001', 1, 'COMMITTED')`,
      [batchId, runId],
    );
  });

  afterAll(async () => {
    try {
      if (rawPool) {
        await rawPool.query(`DELETE FROM record_manifests WHERE migration_run_id = $1`, [runId]).catch(() => {});
        await rawPool.query(`DELETE FROM record_manifest_historical_archive WHERE migration_run_id = $1`, [runId]).catch(() => {});
        await rawPool.query(`DELETE FROM manifest_reconciliation_reports WHERE migration_run_id = $1`, [runId]).catch(() => {});
        await rawPool.query(`DELETE FROM migration_batches WHERE migration_run_id = $1`, [runId]).catch(() => {});
        await rawPool.query(`DELETE FROM migration_runs WHERE id = $1`, [runId]).catch(() => {});
        await rawPool.query(`DELETE FROM migration_plan_versions WHERE id = $1`, [planVersionId]).catch(() => {});
        await rawPool.query(`DELETE FROM migration_plans WHERE id = $1`, [planId]).catch(() => {});
        await rawPool.query(`DELETE FROM connections WHERE id IN ($1, $2)`, [sourceConnId, destConnId]).catch(() => {});
        await rawPool.query(`DELETE FROM projects WHERE id = $1`, [projectId]).catch(() => {});
        await rawPool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => {});
        await rawPool.end().catch(() => {});
      }
    } finally {
      if (dbService) {
        await dbService.onModuleDestroy().catch(() => {});
      }
      for (const [key, value] of Object.entries(initialEnv)) {
        process.env[key] = value;
      }
    }
  });

  it('safely upgrades database containing legacy duplicate manifest rows, preserves historical evidence, and applies uniqueness constraint', async (ctx) => {
    if (!rawPool || !dbService?.isDbConnected) {
      if (isCi) throw new Error('[CI Mandatory Failure] Live database required in CI.');
      ctx.skip();
      return;
    }

    // Step A: Temporarily drop unique constraint to simulate legacy database state
    await rawPool.query(`ALTER TABLE record_manifests DROP CONSTRAINT IF EXISTS uq_record_manifests_run_source`);

    // Step B: Seed legacy duplicate manifests for key 'legacy_cust_101'
    // Row 1: earlier failed attempt
    const failedId = crypto.randomUUID();
    await rawPool.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
         destination_object, destination_key, content_hash, status, error_details, created_at
       ) VALUES ($1, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_101', 'customers_dest', 'cust_101', 'h_old', 'FAILED', 'Connection timeout', NOW() - INTERVAL '10 minutes')`,
      [failedId, runId, batchId],
    );

    // Row 2: later successful attempt (should win authoritative active state)
    const writtenId = crypto.randomUUID();
    await rawPool.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
         destination_object, destination_key, content_hash, status, created_at
       ) VALUES ($1, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_101', 'customers_dest', 'cust_101', 'h_written', 'WRITTEN', NOW() - INTERVAL '5 minutes')`,
      [writtenId, runId, batchId],
    );

    // Step C: Execute manifest reconciliation policy
    const report = await dbService.reconcileManifestDuplicates(runId);

    // Step D: Verify explicit reconciliation report
    expect(report.duplicatesDetected).toBe(1);
    expect(report.distinctIdentitiesAffected).toBe(1);
    expect(report.archivedCount).toBe(1);

    const reportInDb = await rawPool.query(
      `SELECT * FROM manifest_reconciliation_reports WHERE id = $1`,
      [report.reportId],
    );
    expect(reportInDb.rows.length).toBe(1);
    expect(reportInDb.rows[0].reconciliation_policy).toBe('PRESERVE_LATEST_AND_ARCHIVE_SUPERSEDED');
    expect(reportInDb.rows[0].archived_record_count).toBe(1);

    // Step E: Verify historical evidence preserved in archive table (no silent data loss!)
    const archiveRow = await rawPool.query(
      `SELECT * FROM record_manifest_historical_archive WHERE original_manifest_id = $1`,
      [failedId],
    );
    expect(archiveRow.rows.length).toBe(1);
    expect(archiveRow.rows[0].source_key).toBe('legacy_cust_101');
    expect(archiveRow.rows[0].status).toBe('FAILED');
    expect(archiveRow.rows[0].error_details).toBe('Connection timeout');
    expect(archiveRow.rows[0].reconciliation_reason).toBe('DUPLICATE_SUPERSEDED_HISTORICAL_EVIDENCE');

    // Step F: Verify authoritative record remains active in record_manifests
    const activeRows = await rawPool.query(
      `SELECT * FROM record_manifests WHERE migration_run_id = $1 AND source_key = 'legacy_cust_101'`,
      [runId],
    );
    expect(activeRows.rows.length).toBe(1);
    expect(activeRows.rows[0].id).toBe(writtenId);
    expect(activeRows.rows[0].status).toBe('WRITTEN');

    // Step G: Re-run schema migration; verify constraint uq_record_manifests_run_source applies cleanly
    await dbService.runMigrations();

    const constraintCheck = await rawPool.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'uq_record_manifests_run_source'`,
    );
    expect(constraintCheck.rows.length).toBe(1);

    // Step H: Verify constraint actively prevents duplicate manifest insertions
    let duplicateRejected = false;
    try {
      await rawPool.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, status
         ) VALUES ($1, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_101', 'customers_dest', 'cust_101', 'WRITTEN')`,
        [crypto.randomUUID(), runId, batchId],
      );
    } catch (err: any) {
      duplicateRejected = err.code === '23505'; // unique_violation
    }
    expect(duplicateRejected).toBe(true);

    // Step I: Repeatable upgrade check (idempotent when no duplicates exist)
    const secondReport = await dbService.reconcileManifestDuplicates(runId);
    expect(secondReport.duplicatesDetected).toBe(0);
    expect(secondReport.archivedCount).toBe(0);
  });
});
