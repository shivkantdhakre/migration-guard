import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { DatabaseService } from '../src/database/database.service';
import { validateSafeTestDatabaseEndpoint } from './redis-test-utils';

describe('Manifest Schema Upgrade & Historical Reconciliation (Run 005.17 Isolated Fixtures)', () => {
  let rawPool: pg.Pool;
  const isCi = process.env.CI === 'true';
  const initialEnv = { ...process.env };

  const targetDbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;

  const testSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const schemaRun00514 = `test_upgrade_run00514_${testSuffix}`;
  const schemaUnconstrained = `test_upgrade_unconstrained_${testSuffix}`;
  const schemaConcurrency = `test_upgrade_concurrency_${testSuffix}`;

  // Helper to setup isolated schema with uuid helper
  async function createIsolatedSchema(client: pg.PoolClient, schemaName: string) {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await client.query(
      `CREATE OR REPLACE FUNCTION ${schemaName}.uuid_generate_v4()
       RETURNS uuid AS $$
       BEGIN
         RETURN public.uuid_generate_v4();
       EXCEPTION WHEN OTHERS THEN
         RETURN gen_random_uuid();
       END;
       $$ LANGUAGE plpgsql;`
    );
  }

  // DDL generator for actual Run 005.14 schema (commit 2fdc9e8)
  // Has uq_record_manifests_run_source, single-column FK on migration_batch_id,
  // nullable destination coordinates and nullable batch references,
  // NO uq_migration_batches_identity, NO archive tables, NO composite FK.
  async function createRun00514LegacySchema(client: pg.PoolClient, schemaName: string) {
    await createIsolatedSchema(client, schemaName);
    await client.query(`SET search_path TO ${schemaName}`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS connections (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        engine TEXT NOT NULL,
        connection_role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'HEALTHY',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS migration_plans (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS migration_plan_versions (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        plan_id UUID NOT NULL REFERENCES migration_plans(id) ON DELETE CASCADE,
        source_connection_id UUID NOT NULL REFERENCES connections(id),
        destination_connection_id UUID NOT NULL REFERENCES connections(id),
        plan_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS migration_runs (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        plan_version_id UUID NOT NULL REFERENCES migration_plan_versions(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS migration_batches (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        migration_run_id UUID NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
        batch_key TEXT NOT NULL,
        sequence_no BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_batch_run_key UNIQUE (migration_run_id, batch_key)
      );

      CREATE TABLE IF NOT EXISTS id_mappings (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        migration_run_id UUID NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
        source_object TEXT NOT NULL,
        source_key TEXT NOT NULL,
        destination_object TEXT NOT NULL,
        destination_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_id_mapping_source UNIQUE (migration_run_id, source_object, source_key)
      );

      CREATE TABLE IF NOT EXISTS record_manifests (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        migration_run_id UUID NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
        migration_batch_id UUID REFERENCES migration_batches(id) ON DELETE CASCADE,
        batch_key TEXT,
        source_object TEXT NOT NULL,
        source_key TEXT NOT NULL,
        destination_object TEXT,
        destination_key TEXT,
        content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'WRITTEN',
        error_details TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_record_manifests_run_source UNIQUE (migration_run_id, source_object, source_key)
      );
    `);
  }

  // Pre-Run 005.14 unconstrained legacy schema:
  // Same as Run 005.14, but without uq_record_manifests_run_source on record_manifests
  async function createPre00514UnconstrainedSchema(client: pg.PoolClient, schemaName: string) {
    await createIsolatedSchema(client, schemaName);
    await client.query(`SET search_path TO ${schemaName}`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS connections (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        engine TEXT NOT NULL,
        connection_role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'HEALTHY',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS migration_plans (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS migration_plan_versions (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        plan_id UUID NOT NULL REFERENCES migration_plans(id) ON DELETE CASCADE,
        source_connection_id UUID NOT NULL REFERENCES connections(id),
        destination_connection_id UUID NOT NULL REFERENCES connections(id),
        plan_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS migration_runs (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        plan_version_id UUID NOT NULL REFERENCES migration_plan_versions(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS migration_batches (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        migration_run_id UUID NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
        batch_key TEXT NOT NULL,
        sequence_no BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_batch_run_key UNIQUE (migration_run_id, batch_key)
      );

      CREATE TABLE IF NOT EXISTS id_mappings (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        migration_run_id UUID NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
        source_object TEXT NOT NULL,
        source_key TEXT NOT NULL,
        destination_object TEXT NOT NULL,
        destination_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_id_mapping_source UNIQUE (migration_run_id, source_object, source_key)
      );

      CREATE TABLE IF NOT EXISTS record_manifests (
        id UUID PRIMARY KEY DEFAULT ${schemaName}.uuid_generate_v4(),
        migration_run_id UUID NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
        migration_batch_id UUID REFERENCES migration_batches(id) ON DELETE CASCADE,
        batch_key TEXT,
        source_object TEXT NOT NULL,
        source_key TEXT NOT NULL,
        destination_object TEXT,
        destination_key TEXT,
        content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'WRITTEN',
        error_details TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        -- NOTE: NO UNIQUE CONSTRAINT ON RUN_SOURCE
      );
    `);
  }

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

    rawPool = new pg.Pool({ connectionString: targetDbUrl, max: 10 });
  });

  afterAll(async () => {
    try {
      if (rawPool) {
        // Clean up all isolated test schemas
        await rawPool.query(`DROP SCHEMA IF EXISTS ${schemaRun00514} CASCADE`).catch(() => {});
        await rawPool.query(`DROP SCHEMA IF EXISTS ${schemaUnconstrained} CASCADE`).catch(() => {});
        await rawPool.query(`DROP SCHEMA IF EXISTS ${schemaConcurrency} CASCADE`).catch(() => {});

        // Invariance Verification: Ensure public schema constraints were NEVER modified or dropped
        const publicConstraints = await rawPool.query(`
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'public.record_manifests'::regclass
        `).catch(() => ({ rows: [] }));
        const names = new Set(publicConstraints.rows.map((r: any) => r.conname));
        if (names.size > 0) {
          expect(names.has('uq_record_manifests_run_source')).toBe(true);
          expect(names.has('fk_record_manifests_batch_identity')).toBe(true);
        }

        await rawPool.end().catch(() => {});
      }
    } finally {
      for (const [key, value] of Object.entries(initialEnv)) {
        process.env[key] = value;
      }
    }
  });

  it('Requirement 1: faithfully upgrades an isolated Run 005.14 schema fixture to latest schema without fabricating data', async (ctx) => {
    if (!rawPool) {
      if (isCi) throw new Error('[CI Mandatory Failure] Live database required in CI.');
      ctx.skip();
      return;
    }

    const case1Id = crypto.randomUUID();
    const case2Id = crypto.randomUUID();
    const case3Id = crypto.randomUUID();
    const case4Id = crypto.randomUUID();
    const case5Id = crypto.randomUUID();
    const case6Id = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const sourceConnId = crypto.randomUUID();
    const destConnId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    const planVersionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const batchId = crypto.randomUUID();

    const client = await rawPool.connect();
    try {
      // Step 1: Initialize the isolated schema using the actual Run 005.14 DDL
      await createRun00514LegacySchema(client, schemaRun00514);

      // Verify Run 005.14 baseline state before running migrations:
      // a) Archive table does NOT exist
      const archTableCheck = await client.query(`
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = $1 AND table_name = 'record_manifest_historical_archive'
      `, [schemaRun00514]);
      expect(archTableCheck.rows.length).toBe(0);

      // b) Reconciliation reports table does NOT exist
      const repTableCheck = await client.query(`
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = $1 AND table_name = 'manifest_reconciliation_reports'
      `, [schemaRun00514]);
      expect(repTableCheck.rows.length).toBe(0);

      // c) Single-column FK exists on record_manifests
      const singleFkCheck = await client.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = '${schemaRun00514}.record_manifests'::regclass
          AND conname = 'record_manifests_migration_batch_id_fkey'
      `);
      expect(singleFkCheck.rows.length).toBe(1);

      // d) Composite FK does NOT exist
      const compFkCheck = await client.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = '${schemaRun00514}.record_manifests'::regclass
          AND conname = 'fk_record_manifests_batch_identity'
      `);
      expect(compFkCheck.rows.length).toBe(0);

      // e) destination_object, destination_key, batch_key are nullable
      const nullCheck = await client.query(`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'record_manifests'
          AND column_name IN ('destination_object', 'destination_key', 'batch_key')
      `, [schemaRun00514]);
      for (const col of nullCheck.rows) {
        expect(col.is_nullable).toBe('YES');
      }

      // Step 2: Seed canonical relational entities inside the isolated schema
      await client.query(`SET search_path TO ${schemaRun00514}`);

      await client.query(
        `INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)`,
        [workspaceId, `WS ${testSuffix}`, `slug-run00514-${testSuffix}`],
      );
      await client.query(
        `INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, 'Upg Project')`,
        [projectId, workspaceId],
      );
      await client.query(
        `INSERT INTO connections (id, workspace_id, name, engine, connection_role, status)
         VALUES ($1, $2, 'Src', 'MONGODB', 'SOURCE', 'HEALTHY'),
                ($3, $2, 'Dst', 'POSTGRESQL', 'DESTINATION', 'HEALTHY')`,
        [sourceConnId, workspaceId, destConnId],
      );
      await client.query(
        `INSERT INTO migration_plans (id, workspace_id, project_id, name) VALUES ($1, $2, $3, 'Plan')`,
        [planId, workspaceId, projectId],
      );
      await client.query(
        `INSERT INTO migration_plan_versions (id, plan_id, source_connection_id, destination_connection_id, plan_hash)
         VALUES ($1, $2, $3, $4, 'hash_00514')`,
        [planVersionId, planId, sourceConnId, destConnId],
      );
      await client.query(
        `INSERT INTO migration_runs (id, workspace_id, project_id, plan_version_id, status)
         VALUES ($1, $2, $3, $4, 'RUNNING')`,
        [runId, workspaceId, projectId, planVersionId],
      );
      await client.query(
        `INSERT INTO migration_batches (id, migration_run_id, batch_key, sequence_no, status)
         VALUES ($1, $2, 'batch_00514_01', 1, 'COMMITTED')`,
        [batchId, runId],
      );

      // Seed authoritative mapping for coordinate recovery in id_mappings
      await client.query(
        `INSERT INTO id_mappings (
           id, migration_run_id, source_object, source_key, destination_object, destination_key
         ) VALUES ($1, $2, 'customers', 'rec_mapped', 'customers_dest', 'dest_mapped_authoritative')`,
        [crypto.randomUUID(), runId],
      );

      // Step 3: Seed 6 characteristic Run 005.14 manifest records into the legacy fixture:
      // Case 1: Complete valid record
      await client.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status, created_at
         ) VALUES ($1, $2, $3, 'batch_00514_01', 'customers', 'rec_complete', 'customers_dest', 'dest_complete', 'hash_1', 'WRITTEN', NOW() - INTERVAL '30 minutes')`,
        [case1Id, runId, batchId],
      );

      // Case 2: Missing coordinates with matching mapping in id_mappings
      await client.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status, created_at
         ) VALUES ($1, $2, $3, 'batch_00514_01', 'customers', 'rec_mapped', NULL, NULL, 'hash_2', 'WRITTEN', NOW() - INTERVAL '25 minutes')`,
        [case2Id, runId, batchId],
      );

      // Case 3: Missing coordinates WITHOUT mapping (must NOT fabricate data! Must be archived!)
      await client.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status, created_at
         ) VALUES ($1, $2, $3, 'batch_00514_01', 'customers', 'rec_unmapped', NULL, NULL, 'hash_3', 'WRITTEN', NOW() - INTERVAL '20 minutes')`,
        [case3Id, runId, batchId],
      );

      // Case 4: Missing batch ID with resolvable batch (batch_key is 'batch_00514_01' which exists)
      await client.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status, created_at
         ) VALUES ($1, $2, NULL, 'batch_00514_01', 'customers', 'rec_batch_recover_id', 'customers_dest', 'dest_rec_4', 'hash_4', 'WRITTEN', NOW() - INTERVAL '15 minutes')`,
        [case4Id, runId],
      );

      // Case 5: Missing batch key with resolvable batch (migration_batch_id is known batchId)
      await client.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status, created_at
         ) VALUES ($1, $2, $3, NULL, 'customers', 'rec_batch_recover_key', 'customers_dest', 'dest_rec_5', 'hash_5', 'WRITTEN', NOW() - INTERVAL '10 minutes')`,
        [case5Id, runId, batchId],
      );

      // Case 6: Unresolvable batch info (batch_key does not exist in migration_batches)
      await client.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status, created_at
         ) VALUES ($1, $2, NULL, 'batch_non_existent', 'customers', 'rec_batch_unresolvable', 'customers_dest', 'dest_rec_6', 'hash_6', 'WRITTEN', NOW() - INTERVAL '5 minutes')`,
        [case6Id, runId],
      );

      // Verify exactly 6 rows seeded in legacy table
      const preCount = await client.query(`SELECT COUNT(*)::int as count FROM record_manifests`);
      expect(preCount.rows[0].count).toBe(6);
    } finally {
      client.release();
    }

    // Step 4: Instantiate DatabaseService ONLY AFTER legacy schema and data have been created
    const dbServiceRun00514 = new DatabaseService(targetDbUrl, schemaRun00514);
    await dbServiceRun00514.onModuleInit();

    try {
      // Step 5: Execute actual production migration path
      await dbServiceRun00514.runMigrations();

      // Step 6: Verify upgraded schema and data
      const checkClient = await rawPool.connect();
      try {
        await checkClient.query(`SET search_path TO ${schemaRun00514}`);

        // A) Verify new archive and report tables were created in the isolated schema
        const archCheck = await checkClient.query(`
          SELECT 1 FROM information_schema.tables 
          WHERE table_schema = $1 AND table_name = 'record_manifest_historical_archive'
        `, [schemaRun00514]);
        expect(archCheck.rows.length).toBe(1);

        const repCheck = await checkClient.query(`
          SELECT 1 FROM information_schema.tables 
          WHERE table_schema = $1 AND table_name = 'manifest_reconciliation_reports'
        `, [schemaRun00514]);
        expect(repCheck.rows.length).toBe(1);

        // B) Verify constraints: composite FK added, legacy single-column FK dropped
        const constraints = await checkClient.query(`
          SELECT conname, contype FROM pg_constraint
          WHERE conrelid = '${schemaRun00514}.record_manifests'::regclass
        `);
        const conNames = new Set(constraints.rows.map((r: any) => r.conname));
        expect(conNames.has('uq_record_manifests_run_source')).toBe(true);
        expect(conNames.has('fk_record_manifests_batch_identity')).toBe(true);
        expect(conNames.has('record_manifests_migration_batch_id_fkey')).toBe(false);

        // C) Verify NOT NULL constraints applied
        const notNullCheck = await checkClient.query(`
          SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'record_manifests'
            AND column_name IN ('destination_object', 'destination_key', 'migration_batch_id', 'batch_key')
        `, [schemaRun00514]);
        for (const col of notNullCheck.rows) {
          expect(col.is_nullable).toBe('NO');
        }

        // D) Verify active records: exactly 4 resolvable records survive
        const activeRes = await checkClient.query(`SELECT * FROM record_manifests ORDER BY source_key ASC`);
        expect(activeRes.rows.length).toBe(4);
        const activeMap = new Map(activeRes.rows.map((r: any) => [r.source_key, r]));

        // Case 1: Complete record survives intact
        const act1 = activeMap.get('rec_complete');
        expect(act1).toBeDefined();
        expect(act1.id).toBe(case1Id);

        // Case 2: Authoritative coordinates recovered from id_mappings (NOT fabricated!)
        const act2 = activeMap.get('rec_mapped');
        expect(act2).toBeDefined();
        expect(act2.destination_object).toBe('customers_dest');
        expect(act2.destination_key).toBe('dest_mapped_authoritative'); // Authoritative, not source_key!

        // Case 4: Recovered missing batch ID
        const act4 = activeMap.get('rec_batch_recover_id');
        expect(act4).toBeDefined();
        expect(act4.migration_batch_id).toBeDefined();
        expect(act4.batch_key).toBe('batch_00514_01');

        // Case 5: Recovered missing batch key
        const act5 = activeMap.get('rec_batch_recover_key');
        expect(act5).toBeDefined();
        expect(act5.batch_key).toBe('batch_00514_01');

        // E) Verify unresolvable records archived into record_manifest_historical_archive
        const archiveRes = await checkClient.query(`SELECT * FROM record_manifest_historical_archive`);
        expect(archiveRes.rows.length).toBe(2);
        const archiveMap = new Map(archiveRes.rows.map((r: any) => [r.source_key, r]));

        // Case 3 (unmapped coordinates) archived without data loss
        const arch3 = archiveMap.get('rec_unmapped');
        expect(arch3).toBeDefined();
        expect(arch3.reconciliation_reason).toBe('UNRESOLVED_INCOMPLETE_LEGACY_COORDINATES');

        // Case 6 (unresolvable batch) archived without data loss
        const arch6 = archiveMap.get('rec_batch_unresolvable');
        expect(arch6).toBeDefined();
        expect(arch6.reconciliation_reason).toBe('UNRESOLVED_INCOMPLETE_LEGACY_BATCH_RELATION');

        // F) Verify audit report in manifest_reconciliation_reports
        const reportRes = await checkClient.query(`SELECT * FROM manifest_reconciliation_reports`);
        expect(reportRes.rows.length).toBeGreaterThan(0);
        expect(reportRes.rows[0].archived_record_count).toBe(2);

        // G) Verify second run of runMigrations() is 100% idempotent
        await dbServiceRun00514.runMigrations();
        const secondCheck = await checkClient.query(`SELECT COUNT(*)::int as count FROM record_manifests`);
        expect(secondCheck.rows[0].count).toBe(4);
      } finally {
        checkClient.release();
      }
    } finally {
      await dbServiceRun00514.onModuleDestroy();
      await rawPool.query(`DROP SCHEMA IF EXISTS ${schemaRun00514} CASCADE`);
    }
  });

  it('Requirement 2: separate historical duplicate-reconciliation fixture detects duplicates, preserves authoritative record, and archives superseded evidence', async (ctx) => {
    if (!rawPool) {
      if (isCi) throw new Error('[CI Mandatory Failure] Live database required in CI.');
      ctx.skip();
      return;
    }

    const workspaceId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const sourceConnId = crypto.randomUUID();
    const destConnId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    const planVersionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const batchId = crypto.randomUUID();

    const setAOldId = crypto.randomUUID();
    const setANewId = crypto.randomUUID();
    const setBFailedId = crypto.randomUUID();
    const setBWrittenId = crypto.randomUUID();
    const setCOldId = crypto.randomUUID();
    const setCNewId = crypto.randomUUID();
    const singleId = crypto.randomUUID();

    const client = await rawPool.connect();
    try {
      // Step 1: Initialize pre-Run 005.14 unconstrained legacy schema (NO uq_record_manifests_run_source)
      await createPre00514UnconstrainedSchema(client, schemaUnconstrained);

      await client.query(`SET search_path TO ${schemaUnconstrained}`);

      await client.query(
        `INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)`,
        [workspaceId, `WS Unconstrained ${testSuffix}`, `slug-unconstrained-${testSuffix}`],
      );
      await client.query(
        `INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, 'Unconstrained Project')`,
        [projectId, workspaceId],
      );
      await client.query(
        `INSERT INTO connections (id, workspace_id, name, engine, connection_role, status)
         VALUES ($1, $2, 'Src', 'MONGODB', 'SOURCE', 'HEALTHY'),
                ($3, $2, 'Dst', 'POSTGRESQL', 'DESTINATION', 'HEALTHY')`,
        [sourceConnId, workspaceId, destConnId],
      );
      await client.query(
        `INSERT INTO migration_plans (id, workspace_id, project_id, name) VALUES ($1, $2, $3, 'Plan')`,
        [planId, workspaceId, projectId],
      );
      await client.query(
        `INSERT INTO migration_plan_versions (id, plan_id, source_connection_id, destination_connection_id, plan_hash)
         VALUES ($1, $2, $3, $4, 'hash_uncon')`,
        [planVersionId, planId, sourceConnId, destConnId],
      );
      await client.query(
        `INSERT INTO migration_runs (id, workspace_id, project_id, plan_version_id, status)
         VALUES ($1, $2, $3, $4, 'RUNNING')`,
        [runId, workspaceId, projectId, planVersionId],
      );
      await client.query(
        `INSERT INTO migration_batches (id, migration_run_id, batch_key, sequence_no, status)
         VALUES ($1, $2, 'batch_uncon_01', 1, 'COMMITTED')`,
        [batchId, runId],
      );

      // Step 2: Seed duplicate records into unconstrained legacy table
      // Set A: Two FAILED records with different timestamps (older vs newer)
      await client.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status, error_details, created_at
         ) VALUES 
           ($1, $2, $3, 'batch_uncon_01', 'accounts', 'dup_failed_01', 'accounts_dest', 'dest_a1', 'hash_a_old', 'FAILED', 'Old timeout', NOW() - INTERVAL '30 minutes'),
           ($4, $2, $3, 'batch_uncon_01', 'accounts', 'dup_failed_01', 'accounts_dest', 'dest_a1', 'hash_a_new', 'FAILED', 'Newer constraint err', NOW() - INTERVAL '15 minutes')`,
        [setAOldId, runId, batchId, setANewId],
      );

      // Set B: Earlier FAILED vs later WRITTEN duplicate
      await client.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status, error_details, created_at
         ) VALUES 
           ($1, $2, $3, 'batch_uncon_01', 'accounts', 'dup_written_failed_02', 'accounts_dest', 'dest_b1', 'hash_b_old', 'FAILED', 'Initial fail', NOW() - INTERVAL '20 minutes'),
           ($4, $2, $3, 'batch_uncon_01', 'accounts', 'dup_written_failed_02', 'accounts_dest', 'dest_b1', 'hash_b_new', 'WRITTEN', NULL, NOW() - INTERVAL '5 minutes')`,
        [setBFailedId, runId, batchId, setBWrittenId],
      );

      // Set C: Two WRITTEN records with different timestamps
      await client.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status, created_at
         ) VALUES 
           ($1, $2, $3, 'batch_uncon_01', 'accounts', 'dup_written_written_03', 'accounts_dest', 'dest_c1', 'hash_c_old', 'WRITTEN', NOW() - INTERVAL '25 minutes'),
           ($4, $2, $3, 'batch_uncon_01', 'accounts', 'dup_written_written_03', 'accounts_dest', 'dest_c1', 'hash_c_new', 'WRITTEN', NOW() - INTERVAL '10 minutes')`,
        [setCOldId, runId, batchId, setCNewId],
      );

      // Single distinct record without duplicates
      await client.query(
        `INSERT INTO record_manifests (
           id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
           destination_object, destination_key, content_hash, status, created_at
         ) VALUES ($1, $2, $3, 'batch_uncon_01', 'accounts', 'single_rec_04', 'accounts_dest', 'dest_d1', 'hash_d', 'WRITTEN', NOW() - INTERVAL '8 minutes')`,
        [singleId, runId, batchId],
      );

      // Verify 7 rows seeded in unconstrained table (3 sets of duplicates + 1 single)
      const countRes = await client.query(`SELECT COUNT(*)::int as count FROM record_manifests`);
      expect(countRes.rows[0].count).toBe(7);
    } finally {
      client.release();
    }

    // Step 3: Instantiate DatabaseService on the unconstrained schema and run migrations
    const dbServiceUnconstrained = new DatabaseService(targetDbUrl, schemaUnconstrained);
    await dbServiceUnconstrained.onModuleInit();

    try {
      await dbServiceUnconstrained.runMigrations();

      const verifyClient = await rawPool.connect();
      try {
        await verifyClient.query(`SET search_path TO ${schemaUnconstrained}`);

        // A) Exactly 4 distinct records remain in active record_manifests
        const activeRes = await verifyClient.query(`SELECT * FROM record_manifests ORDER BY source_key ASC`);
        expect(activeRes.rows.length).toBe(4);
        const activeMap = new Map(activeRes.rows.map((r: any) => [r.source_key, r]));

        // Set A: Newer FAILED record survives
        const actA = activeMap.get('dup_failed_01');
        expect(actA).toBeDefined();
        expect(actA.error_details).toBe('Newer constraint err');

        // Set B: WRITTEN record survives over earlier FAILED
        const actB = activeMap.get('dup_written_failed_02');
        expect(actB).toBeDefined();
        expect(actB.status).toBe('WRITTEN');

        // Set C: Newer WRITTEN record survives
        const actC = activeMap.get('dup_written_written_03');
        expect(actC).toBeDefined();
        expect(actC.content_hash).toBe('hash_c_new');

        // Single record untouched
        const actD = activeMap.get('single_rec_04');
        expect(actD).toBeDefined();
        expect(actD.id).toBe(singleId);

        // B) Exactly 3 superseded duplicates archived into record_manifest_historical_archive
        const archRes = await verifyClient.query(`SELECT * FROM record_manifest_historical_archive`);
        expect(archRes.rows.length).toBe(3);
        for (const archRow of archRes.rows) {
          expect(archRow.reconciliation_reason).toBe('DUPLICATE_SUPERSEDED_HISTORICAL_EVIDENCE');
          expect(archRow.reconciliation_policy).toBe('PRESERVE_LATEST_AND_ARCHIVE_SUPERSEDED');
        }

        // C) Audit report recorded in manifest_reconciliation_reports
        const repRes = await verifyClient.query(`SELECT * FROM manifest_reconciliation_reports`);
        expect(repRes.rows.length).toBeGreaterThan(0);
        expect(repRes.rows[0].total_duplicates_detected).toBe(3);
        expect(repRes.rows[0].distinct_identities_affected).toBe(3);
        expect(repRes.rows[0].archived_record_count).toBe(3);

        // D) Unique constraint uq_record_manifests_run_source now actively enforced
        const uqCheck = await verifyClient.query(`
          SELECT 1 FROM pg_constraint
          WHERE conrelid = '${schemaUnconstrained}.record_manifests'::regclass
            AND conname = 'uq_record_manifests_run_source'
            AND contype = 'u'
        `);
        expect(uqCheck.rows.length).toBe(1);

        // Verify active rejection of duplicates
        let dupBlocked = false;
        try {
          await verifyClient.query(
            `INSERT INTO record_manifests (
               id, migration_run_id, migration_batch_id, batch_key, source_object, source_key,
               destination_object, destination_key, status
             ) VALUES ($1, $2, $3, 'batch_uncon_01', 'accounts', 'single_rec_04', 'accounts_dest', 'dest_d1', 'WRITTEN')`,
            [crypto.randomUUID(), runId, batchId],
          );
        } catch (err: any) {
          dupBlocked = err.code === '23505'; // PostgreSQL unique_violation code
        }
        expect(dupBlocked).toBe(true);
      } finally {
        verifyClient.release();
      }
    } finally {
      await dbServiceUnconstrained.onModuleDestroy();
      await rawPool.query(`DROP SCHEMA IF EXISTS ${schemaUnconstrained} CASCADE`);
    }
  });

  it('Requirement 3: serializes concurrent migration runs using PostgreSQL advisory locks without deadlocks or constraint collisions', async (ctx) => {
    if (!rawPool) {
      if (isCi) throw new Error('[CI Mandatory Failure] Live database required in CI.');
      ctx.skip();
      return;
    }

    const initClient = await rawPool.connect();
    try {
      await createRun00514LegacySchema(initClient, schemaConcurrency);
    } finally {
      initClient.release();
    }

    const dbServiceC1 = new DatabaseService(targetDbUrl, schemaConcurrency);
    const dbServiceC2 = new DatabaseService(targetDbUrl, schemaConcurrency);

    await Promise.all([dbServiceC1.onModuleInit(), dbServiceC2.onModuleInit()]);

    try {
      // Execute concurrent migrations simultaneously
      await Promise.all([
        dbServiceC1.runMigrations(),
        dbServiceC2.runMigrations(),
        dbServiceC1.runMigrations(),
      ]);

      const verifyClient = await rawPool.connect();
      try {
        const uqCheck = await verifyClient.query(`
          SELECT COUNT(*)::int as count 
          FROM pg_constraint 
          WHERE conname = 'uq_record_manifests_run_source'
            AND conrelid = '${schemaConcurrency}.record_manifests'::regclass
        `);
        expect(uqCheck.rows[0].count).toBe(1);

        const fkCheck = await verifyClient.query(`
          SELECT COUNT(*)::int as count 
          FROM pg_constraint 
          WHERE conname = 'fk_record_manifests_batch_identity'
            AND conrelid = '${schemaConcurrency}.record_manifests'::regclass
        `);
        expect(fkCheck.rows[0].count).toBe(1);
      } finally {
        verifyClient.release();
      }
    } finally {
      await Promise.all([dbServiceC1.onModuleDestroy(), dbServiceC2.onModuleDestroy()]);
      await rawPool.query(`DROP SCHEMA IF EXISTS ${schemaConcurrency} CASCADE`);
    }
  });
});
