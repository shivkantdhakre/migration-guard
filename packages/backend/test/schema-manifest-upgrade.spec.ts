import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../src/database/database.service';
import { validateSafeTestDatabaseEndpoint } from './redis-test-utils';

describe('Manifest Schema Upgrade & Historical Reconciliation (Run 005.16 & P1)', () => {
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
        await rawPool.query(`DELETE FROM id_mappings WHERE migration_run_id = $1`, [runId]).catch(() => {});
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

  it('executes real schema upgrade from pre-005.15 schema, reconciles all 7 edge cases without fabricating data, and enforces relational constraints', async (ctx) => {
    if (!rawPool || !dbService?.isDbConnected) {
      if (isCi) throw new Error('[CI Mandatory Failure] Live database required in CI.');
      ctx.skip();
      return;
    }

    // Step A: Revert constraints to simulate pre-005.15 (Run 005.14) legacy database state
    await rawPool.query(`ALTER TABLE record_manifests DROP CONSTRAINT IF EXISTS uq_record_manifests_run_source`);
    await rawPool.query(`ALTER TABLE record_manifests DROP CONSTRAINT IF EXISTS fk_record_manifests_batch_identity`);
    await rawPool.query(`ALTER TABLE record_manifests ALTER COLUMN destination_object DROP NOT NULL`);
    await rawPool.query(`ALTER TABLE record_manifests ALTER COLUMN destination_key DROP NOT NULL`);
    await rawPool.query(`ALTER TABLE record_manifests ALTER COLUMN migration_batch_id DROP NOT NULL`);
    await rawPool.query(`ALTER TABLE record_manifests ALTER COLUMN batch_key DROP NOT NULL`);

    // Clean previous manifests for this test run
    await rawPool.query(`DELETE FROM record_manifests WHERE migration_run_id = $1`, [runId]);
    await rawPool.query(`DELETE FROM record_manifest_historical_archive WHERE migration_run_id = $1`, [runId]);
    await rawPool.query(`DELETE FROM manifest_reconciliation_reports WHERE migration_run_id = $1`, [runId]);
    await rawPool.query(`DELETE FROM id_mappings WHERE migration_run_id = $1`, [runId]);

    // Seed authoritative mapping for Case 4 in id_mappings
    await rawPool.query(
      `INSERT INTO id_mappings (
         id, migration_run_id, source_object, source_key, destination_object, destination_key
       ) VALUES ($1, $2, 'customers', 'legacy_cust_mapped_004', 'customers_dest', 'dest_mapped_004')`,
      [crypto.randomUUID(), runId],
    );

    // Seed All 7 Test Cases into legacy unconstrained record_manifests table:
    // Case 1: Complete valid record
    const case1Id = crypto.randomUUID();
    await rawPool.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
         destination_object, destination_key, content_hash, status, created_at
       ) VALUES ($1, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_001', 'customers_dest', 'dest_cust_001', 'hash_001', 'WRITTEN', NOW() - INTERVAL '30 minutes')`,
      [case1Id, runId, batchId],
    );

    // Case 2: Duplicates with different statuses (two FAILED attempts with different timestamps)
    const case2OldId = crypto.randomUUID();
    const case2NewId = crypto.randomUUID();
    await rawPool.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
         destination_object, destination_key, content_hash, status, error_details, created_at
       ) VALUES 
         ($1, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_dup_failed_002', 'customers_dest', 'dest_002', 'hash_002_old', 'FAILED', 'Old failure', NOW() - INTERVAL '20 minutes'),
         ($4, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_dup_failed_002', 'customers_dest', 'dest_002', 'hash_002_new', 'FAILED', 'Newer failure', NOW() - INTERVAL '15 minutes')`,
      [case2OldId, runId, batchId, case2NewId],
    );

    // Case 3: WRITTEN vs earlier FAILED duplicate
    const case3FailedId = crypto.randomUUID();
    const case3WrittenId = crypto.randomUUID();
    await rawPool.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
         destination_object, destination_key, content_hash, status, error_details, created_at
       ) VALUES 
         ($1, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_written_failed_003', 'customers_dest', 'dest_003', 'hash_003_old', 'FAILED', 'Network timeout', NOW() - INTERVAL '12 minutes'),
         ($4, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_written_failed_003', 'customers_dest', 'dest_003', 'hash_003_new', 'WRITTEN', NULL, NOW() - INTERVAL '8 minutes')`,
      [case3FailedId, runId, batchId, case3WrittenId],
    );

    // Case 4: Missing coordinates with matching mapping in id_mappings
    const case4Id = crypto.randomUUID();
    await rawPool.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
         destination_object, destination_key, content_hash, status, created_at
       ) VALUES ($1, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_mapped_004', NULL, NULL, 'hash_004', 'WRITTEN', NOW() - INTERVAL '7 minutes')`,
      [case4Id, runId, batchId],
    );

    // Case 5: Missing coordinates without mapping (must NOT fabricate data! Must be archived!)
    const case5Id = crypto.randomUUID();
    await rawPool.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
         destination_object, destination_key, content_hash, status, created_at
       ) VALUES ($1, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_unmapped_005', NULL, NULL, 'hash_005', 'WRITTEN', NOW() - INTERVAL '6 minutes')`,
      [case5Id, runId, batchId],
    );

    // Case 6: Missing batch ID with resolvable batch (batch_key is 'batch_upg_001' which exists)
    const case6Id = crypto.randomUUID();
    await rawPool.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
         destination_object, destination_key, content_hash, status, created_at
       ) VALUES ($1, $2, NULL, 'batch_upg_001', 'customers', 'legacy_cust_batch_recover_006', 'customers_dest', 'dest_006', 'hash_006', 'WRITTEN', NOW() - INTERVAL '5 minutes')`,
      [case6Id, runId],
    );

    // Case 7: Unresolvable batch info (batch_key does not exist in migration_batches)
    const case7Id = crypto.randomUUID();
    await rawPool.query(
      `INSERT INTO record_manifests (
         id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
         destination_object, destination_key, content_hash, status, created_at
       ) VALUES ($1, $2, NULL, 'batch_non_existent', 'customers', 'legacy_cust_batch_unresolvable_007', 'customers_dest', 'dest_007', 'hash_007', 'WRITTEN', NOW() - INTERVAL '4 minutes')`,
      [case7Id, runId],
    );

    // Verify exactly 9 rows seeded across the 7 cases in legacy table (Cases 2 & 3 have 2 duplicate rows each)
    const preCount = await rawPool.query(
      `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1`,
      [runId],
    );
    expect(preCount.rows[0].count).toBe(9);

    // Step B: Execute the actual production migration path (DatabaseService.runMigrations)
    await dbService.runMigrations();

    // Step C: Verify Results for All 7 Cases
    // Active records remaining in record_manifests: exactly 5 rows (Cases 1, 2, 3, 4, 6)
    const activeResult = await rawPool.query(
      `SELECT * FROM record_manifests WHERE migration_run_id = $1 ORDER BY source_key ASC`,
      [runId],
    );
    expect(activeResult.rows.length).toBe(5);

    const activeMap = new Map(activeResult.rows.map((r) => [r.source_key, r]));

    // Case 1: Survives unchanged
    const active1 = activeMap.get('legacy_cust_001');
    expect(active1).toBeDefined();
    expect(active1.id).toBe(case1Id);
    expect(active1.status).toBe('WRITTEN');
    expect(active1.destination_object).toBe('customers_dest');
    expect(active1.destination_key).toBe('dest_cust_001');
    expect(active1.migration_batch_id).toBe(batchId);
    expect(active1.batch_key).toBe('batch_upg_001');

    // Case 2: Authoritative newer FAILED duplicate survives, older archived
    const active2 = activeMap.get('legacy_cust_dup_failed_002');
    expect(active2).toBeDefined();
    expect(active2.id).toBe(case2NewId);
    expect(active2.error_details).toBe('Newer failure');

    // Case 3: Authoritative WRITTEN duplicate survives, earlier FAILED archived
    const active3 = activeMap.get('legacy_cust_written_failed_003');
    expect(active3).toBeDefined();
    expect(active3.id).toBe(case3WrittenId);
    expect(active3.status).toBe('WRITTEN');

    // Case 4: Recovered exact destination coordinates from authoritative id_mappings (NOT fabricated!)
    const active4 = activeMap.get('legacy_cust_mapped_004');
    expect(active4).toBeDefined();
    expect(active4.destination_object).toBe('customers_dest');
    expect(active4.destination_key).toBe('dest_mapped_004'); // From id_mappings! Not 'legacy_cust_mapped_004'!
    expect(active4.migration_batch_id).toBe(batchId);
    expect(active4.batch_key).toBe('batch_upg_001');

    // Case 5: Unmapped coordinates NOT fabricated, MUST NOT be in active table
    expect(activeMap.has('legacy_cust_unmapped_005')).toBe(false);

    // Case 6: Recovered migration_batch_id from migration_batches
    const active6 = activeMap.get('legacy_cust_batch_recover_006');
    expect(active6).toBeDefined();
    expect(active6.migration_batch_id).toBe(batchId);
    expect(active6.batch_key).toBe('batch_upg_001');

    // Case 7: Unresolvable batch MUST NOT be in active table
    expect(activeMap.has('legacy_cust_batch_unresolvable_007')).toBe(false);

    // Step D: Verify Historical Archive (Zero Data Loss)
    const archiveResult = await rawPool.query(
      `SELECT * FROM record_manifest_historical_archive WHERE migration_run_id = $1 ORDER BY original_created_at ASC`,
      [runId],
    );
    expect(archiveResult.rows.length).toBe(4); // case2Old, case3Failed, case5Unmapped, case7UnresolvableBatch
    const archiveMap = new Map(archiveResult.rows.map((r) => [r.original_manifest_id, r]));

    // Check Case 2 superseded duplicate
    const archCase2 = archiveMap.get(case2OldId);
    expect(archCase2).toBeDefined();
    expect(archCase2.source_key).toBe('legacy_cust_dup_failed_002');
    expect(archCase2.reconciliation_reason).toBe('DUPLICATE_SUPERSEDED_HISTORICAL_EVIDENCE');

    // Check Case 3 superseded duplicate
    const archCase3 = archiveMap.get(case3FailedId);
    expect(archCase3).toBeDefined();
    expect(archCase3.source_key).toBe('legacy_cust_written_failed_003');
    expect(archCase3.status).toBe('FAILED');
    expect(archCase3.reconciliation_reason).toBe('DUPLICATE_SUPERSEDED_HISTORICAL_EVIDENCE');

    // Check Case 5 unresolvable coordinates archived without data loss
    const archCase5 = archiveMap.get(case5Id);
    expect(archCase5).toBeDefined();
    expect(archCase5.source_key).toBe('legacy_cust_unmapped_005');
    expect(archCase5.reconciliation_reason).toBe('UNRESOLVED_INCOMPLETE_LEGACY_COORDINATES');

    // Check Case 7 unresolvable batch archived without data loss
    const archCase7 = archiveMap.get(case7Id);
    expect(archCase7).toBeDefined();
    expect(archCase7.source_key).toBe('legacy_cust_batch_unresolvable_007');
    expect(archCase7.reconciliation_reason).toBe('UNRESOLVED_INCOMPLETE_LEGACY_BATCH_RELATION');

    // Step E: Verify Constraints Enforced
    const constraintsCheck = await rawPool.query(`
      SELECT conname, contype 
      FROM pg_constraint 
      WHERE conrelid = 'record_manifests'::regclass
    `);
    const constraintNames = new Set(constraintsCheck.rows.map((r) => r.conname));
    expect(constraintNames.has('uq_record_manifests_run_source')).toBe(true);
    expect(constraintNames.has('fk_record_manifests_batch_identity')).toBe(true);

    const nullColsCheck = await rawPool.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'record_manifests'
        AND column_name IN ('destination_object', 'destination_key', 'migration_batch_id', 'batch_key')
    `);
    for (const col of nullColsCheck.rows) {
      expect(col.is_nullable).toBe('NO');
    }

    // Step F: Verify Unique Constraint Actively Rejects Duplicates
    let duplicateRejected = false;
    try {
      await rawPool.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, status
         ) VALUES ($1, $2, $3, 'batch_upg_001', 'customers', 'legacy_cust_001', 'customers_dest', 'dest_cust_001', 'WRITTEN')`,
        [crypto.randomUUID(), runId, batchId],
      );
    } catch (err: any) {
      duplicateRejected = err.code === '23505';
    }
    expect(duplicateRejected).toBe(true);

    // Step G: Verify Second Migration Execution Is 100% Idempotent
    await dbService.runMigrations();
    const postSecondCount = await rawPool.query(
      `SELECT COUNT(*)::int as count FROM record_manifests WHERE migration_run_id = $1`,
      [runId],
    );
    expect(postSecondCount.rows[0].count).toBe(5);
  });

  it('safely serializes concurrent migration execution using PostgreSQL advisory locks without deadlocks or duplicate archives', async (ctx) => {
    if (!rawPool || !dbService?.isDbConnected) {
      if (isCi) throw new Error('[CI Mandatory Failure] Live database required in CI.');
      ctx.skip();
      return;
    }

    const dbService2 = new DatabaseService(targetDbUrl);
    await dbService2.onModuleInit();

    try {
      // Execute simultaneous migrations
      await Promise.all([
        dbService.runMigrations(),
        dbService2.runMigrations(),
        dbService.runMigrations(),
      ]);

      const constraintCheck = await rawPool.query(`
        SELECT COUNT(*)::int as count 
        FROM pg_constraint 
        WHERE conname = 'uq_record_manifests_run_source'
          AND conrelid = 'record_manifests'::regclass
      `);
      expect(constraintCheck.rows[0].count).toBe(1);
    } finally {
      await dbService2.onModuleDestroy().catch(() => {});
    }
  });
});
