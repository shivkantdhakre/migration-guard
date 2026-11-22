import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseService } from '../src/database/database.service';
import { validateSafeTestDatabaseEndpoint } from './redis-test-utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const run00514DdlPath = path.resolve(__dirname, 'fixtures/run-005-14-schema.sql');

describe('Manifest Schema Upgrade & Historical Reconciliation (Run 005.19 Complete Schema Parity)', () => {
  let rawPool: pg.Pool;
  const isCi = process.env.CI === 'true';
  const initialEnv = { ...process.env };

  const targetDbUrl =
    process.env.MIGRATIONGUARD_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;

  const testSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const schemaRun00514 = `test_upgrade_run00514_${testSuffix}`;
  const schemaUnconstrained = `test_upgrade_unconstrained_${testSuffix}`;
  const schemaConcurrency = `test_upgrade_concurrency_${testSuffix}`;

  // =========================================================================
  // Schema Catalog Interfaces & Expected Delta Definitions (Run 005.19)
  // =========================================================================

  interface ColumnCatalogEntry {
    table_name: string;
    column_name: string;
    ordinal_position: number;
    column_default: string | null;
    is_nullable: string; // 'YES' | 'NO'
    data_type: string;
    udt_name: string;
    character_maximum_length: number | null;
    numeric_precision: number | null;
    numeric_scale: number | null;
  }

  interface ConstraintCatalogEntry {
    table_name: string;
    constraint_name: string;
    constraint_type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK';
    definition: string;
  }

  interface IndexCatalogEntry {
    table_name: string;
    index_name: string;
    index_definition: string;
  }

  interface SchemaCatalog {
    tables: string[];
    columns: Map<string, ColumnCatalogEntry[]>;
    primaryKeys: Map<string, ConstraintCatalogEntry>;
    uniqueConstraints: Map<string, ConstraintCatalogEntry[]>;
    foreignKeys: Map<string, ConstraintCatalogEntry[]>;
    checkConstraints: Map<string, ConstraintCatalogEntry[]>;
    indexes: Map<string, IndexCatalogEntry[]>;
  }

  const EXPECTED_SCHEMA_DELTA = {
    addedTables: [
      'record_manifest_historical_archive',
      'manifest_reconciliation_reports',
    ],
    removedTables: [] as string[],
    modifiedTables: {
      record_manifests: {
        nullabilityChanges: {
          destination_object: { from: 'YES', to: 'NO' },
          destination_key: { from: 'YES', to: 'NO' },
          migration_batch_id: { from: 'YES', to: 'NO' },
          batch_key: { from: 'YES', to: 'NO' },
        },
      },
      migration_batches: {},
    },
  };

  async function captureSchemaCatalog(client: pg.PoolClient, schemaName: string): Promise<SchemaCatalog> {
    await client.query(`SET search_path TO ${schemaName}`);

    // 1. Tables (BASE TABLE)
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `, [schemaName]);
    const tables: string[] = tablesRes.rows.map((r: any) => r.table_name);

    // 2. Columns
    const colsRes = await client.query(`
      SELECT 
        table_name, column_name, ordinal_position, column_default,
        is_nullable, data_type, udt_name, character_maximum_length,
        numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position
    `, [schemaName]);

    const columns = new Map<string, ColumnCatalogEntry[]>();
    for (const r of colsRes.rows) {
      if (!columns.has(r.table_name)) columns.set(r.table_name, []);
      const normalizedDefault = r.column_default ? r.column_default.replaceAll(`${schemaName}.`, '') : null;
      columns.get(r.table_name)!.push({
        table_name: r.table_name,
        column_name: r.column_name,
        ordinal_position: Number(r.ordinal_position),
        column_default: normalizedDefault,
        is_nullable: r.is_nullable,
        data_type: r.data_type,
        udt_name: r.udt_name,
        character_maximum_length: r.character_maximum_length,
        numeric_precision: r.numeric_precision,
        numeric_scale: r.numeric_scale,
      });
    }

    // 3. Constraints from pg_constraint
    const constraintsRes = await client.query(`
      SELECT 
        t.relname AS table_name,
        c.conname AS constraint_name,
        c.contype AS constraint_type_code,
        pg_get_constraintdef(c.oid) AS raw_definition
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE n.nspname = $1
      ORDER BY t.relname, c.conname
    `, [schemaName]);

    const primaryKeys = new Map<string, ConstraintCatalogEntry>();
    const uniqueConstraints = new Map<string, ConstraintCatalogEntry[]>();
    const foreignKeys = new Map<string, ConstraintCatalogEntry[]>();
    const checkConstraints = new Map<string, ConstraintCatalogEntry[]>();

    for (const r of constraintsRes.rows) {
      const normalizedDef = (r.raw_definition || '')
        .replaceAll(`${schemaName}.`, '')
        .replace(/\s+/g, ' ')
        .trim();

      const entry: ConstraintCatalogEntry = {
        table_name: r.table_name,
        constraint_name: r.constraint_name,
        constraint_type: r.constraint_type_code === 'p' ? 'PRIMARY KEY'
          : r.constraint_type_code === 'u' ? 'UNIQUE'
          : r.constraint_type_code === 'f' ? 'FOREIGN KEY'
          : 'CHECK',
        definition: normalizedDef,
      };

      if (r.constraint_type_code === 'p') {
        primaryKeys.set(r.table_name, entry);
      } else if (r.constraint_type_code === 'u') {
        if (!uniqueConstraints.has(r.table_name)) uniqueConstraints.set(r.table_name, []);
        uniqueConstraints.get(r.table_name)!.push(entry);
      } else if (r.constraint_type_code === 'f') {
        if (!foreignKeys.has(r.table_name)) foreignKeys.set(r.table_name, []);
        foreignKeys.get(r.table_name)!.push(entry);
      } else if (r.constraint_type_code === 'c') {
        if (!checkConstraints.has(r.table_name)) checkConstraints.set(r.table_name, []);
        checkConstraints.get(r.table_name)!.push(entry);
      }
    }

    // 4. Indexes from pg_indexes
    const idxRes = await client.query(`
      SELECT tablename AS table_name, indexname AS index_name, indexdef AS raw_indexdef
      FROM pg_indexes
      WHERE schemaname = $1
      ORDER BY tablename, indexname
    `, [schemaName]);

    const indexes = new Map<string, IndexCatalogEntry[]>();
    for (const r of idxRes.rows) {
      const normalizedIdxDef = (r.raw_indexdef || '')
        .replaceAll(`${schemaName}.`, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!indexes.has(r.table_name)) indexes.set(r.table_name, []);
      indexes.get(r.table_name)!.push({
        table_name: r.table_name,
        index_name: r.index_name,
        index_definition: normalizedIdxDef,
      });
    }

    return {
      tables,
      columns,
      primaryKeys,
      uniqueConstraints,
      foreignKeys,
      checkConstraints,
      indexes,
    };
  }

  function assertSchemaCatalogParity(
    baseline: SchemaCatalog,
    postUpgrade: SchemaCatalog,
    schemaName: string,
  ) {
    // 1. Table Parity & Delta Verification
    expect(baseline.tables.length, 'Baseline must contain all 22 Run 005.14 historical tables').toBe(22);
    expect(postUpgrade.tables.length, 'Post-upgrade catalog must contain exactly 24 tables (22 historical + 2 archive/reconciliation)').toBe(24);

    // Assert every historical table exists in post-upgrade
    for (const tbl of baseline.tables) {
      expect(postUpgrade.tables.includes(tbl), `Historical table ${tbl} must be preserved post-upgrade`).toBe(true);
    }

    // Assert new tables match expected additions exactly
    const addedTables = postUpgrade.tables.filter((t) => !baseline.tables.includes(t));
    expect(addedTables.sort()).toEqual([...EXPECTED_SCHEMA_DELTA.addedTables].sort());

    // Assert no unexpected tables were removed
    const removedTables = baseline.tables.filter((t) => !postUpgrade.tables.includes(t));
    expect(removedTables).toEqual(EXPECTED_SCHEMA_DELTA.removedTables);

    // 2. Comprehensive Column Definitions Across ALL 22 Historical Tables
    for (const tbl of baseline.tables) {
      const baseCols = baseline.columns.get(tbl) || [];
      const postCols = postUpgrade.columns.get(tbl) || [];

      expect(
        postCols.length,
        `Table ${tbl} column count must match historical baseline (expected ${baseCols.length}, got ${postCols.length})`,
      ).toBe(baseCols.length);

      const baseColMap = new Map(baseCols.map((c) => [c.column_name, c]));
      const postColMap = new Map(postCols.map((c) => [c.column_name, c]));

      // All column names and ordinals must match
      expect(
        Array.from(postColMap.keys()),
        `Table ${tbl} columns must preserve exact names and ordering`,
      ).toEqual(Array.from(baseColMap.keys()));

      for (const [colName, baseCol] of baseColMap.entries()) {
        const postCol = postColMap.get(colName)!;
        expect(postCol, `Column ${tbl}.${colName} must exist in post-upgrade catalog`).toBeDefined();

        // Invariant column attributes
        expect(postCol.ordinal_position, `Column ${tbl}.${colName} ordinal position mismatch`).toBe(baseCol.ordinal_position);
        expect(postCol.data_type, `Column ${tbl}.${colName} data type mismatch`).toBe(baseCol.data_type);
        expect(postCol.udt_name, `Column ${tbl}.${colName} UDT mismatch`).toBe(baseCol.udt_name);
        expect(postCol.character_maximum_length, `Column ${tbl}.${colName} max length mismatch`).toBe(baseCol.character_maximum_length);
        expect(postCol.numeric_precision, `Column ${tbl}.${colName} numeric precision mismatch`).toBe(baseCol.numeric_precision);
        expect(postCol.numeric_scale, `Column ${tbl}.${colName} numeric scale mismatch`).toBe(baseCol.numeric_scale);
        expect(postCol.column_default, `Column ${tbl}.${colName} default value mismatch`).toBe(baseCol.column_default);

        // Nullability: check whether this column has an explicit intended change
        const nullDelta = (EXPECTED_SCHEMA_DELTA.modifiedTables as any)[tbl]?.nullabilityChanges?.[colName];
        if (nullDelta) {
          expect(baseCol.is_nullable, `Baseline nullability for ${tbl}.${colName} must match expected delta 'from'`).toBe(nullDelta.from);
          expect(postCol.is_nullable, `Post-upgrade nullability for ${tbl}.${colName} must match expected delta 'to'`).toBe(nullDelta.to);
        } else {
          expect(postCol.is_nullable, `Column ${tbl}.${colName} nullability unexpectedly changed`).toBe(baseCol.is_nullable);
        }
      }
    }

    // 3. Primary Key Preservation Across ALL 22 Historical Tables
    for (const tbl of baseline.tables) {
      const basePk = baseline.primaryKeys.get(tbl);
      const postPk = postUpgrade.primaryKeys.get(tbl);

      expect(basePk, `Historical table ${tbl} must have primary key in baseline`).toBeDefined();
      expect(postPk, `Historical table ${tbl} must preserve primary key post-upgrade`).toBeDefined();
      expect(postPk!.constraint_name, `Primary key name mismatch on table ${tbl}`).toBe(basePk!.constraint_name);
      expect(postPk!.definition, `Primary key definition mismatch on table ${tbl}`).toBe(basePk!.definition);
    }

    // Verify primary keys on newly added tables
    for (const addedTbl of EXPECTED_SCHEMA_DELTA.addedTables) {
      expect(
        postUpgrade.primaryKeys.get(addedTbl),
        `Newly added table ${addedTbl} must have primary key`,
      ).toBeDefined();
    }

    // 4. Unique Constraints Across ALL 22 Historical Tables
    for (const tbl of baseline.tables) {
      const baseUniq = baseline.uniqueConstraints.get(tbl) || [];
      const postUniq = postUpgrade.uniqueConstraints.get(tbl) || [];

      if (tbl === 'migration_batches') {
        // Exactly 1 added unique constraint: uq_migration_batches_identity
        expect(baseUniq.length, 'migration_batches must have exactly 1 unique constraint in baseline').toBe(1);
        expect(postUniq.length, 'migration_batches must have exactly 2 unique constraints post-upgrade').toBe(2);

        const baseRunKey = baseUniq.find((u) => u.constraint_name === 'uq_batch_run_key');
        const postRunKey = postUniq.find((u) => u.constraint_name === 'uq_batch_run_key');
        expect(postRunKey, 'uq_batch_run_key must be preserved').toBeDefined();
        expect(postRunKey!.definition).toBe(baseRunKey!.definition);

        const postIdentity = postUniq.find((u) => u.constraint_name === 'uq_migration_batches_identity');
        expect(postIdentity, 'uq_migration_batches_identity must be added').toBeDefined();
        expect(postIdentity!.definition).toMatch(/UNIQUE \(id, migration_run_id, batch_key\)/);
      } else {
        // Unaffected tables: exact unique constraint preservation
        expect(
          postUniq.length,
          `Table ${tbl} unique constraint count changed unexpectedly`,
        ).toBe(baseUniq.length);

        for (const baseU of baseUniq) {
          const postU = postUniq.find((u) => u.constraint_name === baseU.constraint_name);
          expect(postU, `Unique constraint ${baseU.constraint_name} on ${tbl} missing post-upgrade`).toBeDefined();
          expect(postU!.definition, `Unique constraint ${baseU.constraint_name} definition mismatch`).toBe(baseU.definition);
        }
      }
    }

    // 5. Foreign Key Constraints Across ALL 22 Historical Tables
    for (const tbl of baseline.tables) {
      const baseFks = baseline.foreignKeys.get(tbl) || [];
      const postFks = postUpgrade.foreignKeys.get(tbl) || [];

      if (tbl === 'record_manifests') {
        // Intended FK change: legacy FK dropped, composite FK added, run FK preserved
        expect(baseFks.length, 'record_manifests baseline foreign keys').toBe(2);
        expect(postFks.length, 'record_manifests post-upgrade foreign keys').toBe(2);

        // Legacy single FK must be dropped
        const postLegacyFk = postFks.find((f) => f.constraint_name === 'record_manifests_migration_batch_id_fkey');
        expect(postLegacyFk, 'Legacy single-column FK must be dropped').toBeUndefined();

        // Composite FK must be added
        const postCompositeFk = postFks.find((f) => f.constraint_name === 'fk_record_manifests_batch_identity');
        expect(postCompositeFk, 'Composite FK fk_record_manifests_batch_identity must exist').toBeDefined();
        expect(postCompositeFk!.definition).toMatch(
          /FOREIGN KEY \(migration_batch_id, migration_run_id, batch_key\) REFERENCES migration_batches\(id, migration_run_id, batch_key\) ON DELETE CASCADE/,
        );

        // Run FK must be preserved
        const baseRunFk = baseFks.find((f) => f.constraint_name === 'record_manifests_migration_run_id_fkey');
        const postRunFk = postFks.find((f) => f.constraint_name === 'record_manifests_migration_run_id_fkey');
        expect(postRunFk, 'record_manifests_migration_run_id_fkey must be preserved').toBeDefined();
        expect(postRunFk!.definition).toBe(baseRunFk!.definition);
      } else {
        // Unaffected tables: exact foreign key preservation
        expect(
          postFks.length,
          `Table ${tbl} foreign key count changed unexpectedly`,
        ).toBe(baseFks.length);

        for (const baseFk of baseFks) {
          const postFk = postFks.find((f) => f.constraint_name === baseFk.constraint_name);
          expect(postFk, `Foreign key ${baseFk.constraint_name} on ${tbl} missing post-upgrade`).toBeDefined();
          expect(postFk!.definition, `Foreign key ${baseFk.constraint_name} definition mismatch`).toBe(baseFk.definition);
        }
      }
    }

    // 6. Check Constraints Across ALL 22 Historical Tables
    for (const tbl of baseline.tables) {
      const baseChks = baseline.checkConstraints.get(tbl) || [];
      const postChks = postUpgrade.checkConstraints.get(tbl) || [];
      expect(postChks.length, `Table ${tbl} check constraint count mismatch`).toBe(baseChks.length);
      for (const baseC of baseChks) {
        const postC = postChks.find((c) => c.constraint_name === baseC.constraint_name);
        expect(postC, `Check constraint ${baseC.constraint_name} on ${tbl} missing`).toBeDefined();
        expect(postC!.definition, `Check constraint ${baseC.constraint_name} definition mismatch`).toBe(baseC.definition);
      }
    }

    // 7. Index Definitions Across ALL 22 Historical Tables
    const expectedSecondaryIndexes = [
      'ix_workspaces_status',
      'ix_members_user',
      'ix_projects_workspace',
      'ix_connections_workspace',
      'ix_snapshots_connection',
      'ix_plans_workspace_project',
      'ix_runs_workspace_status',
      'ix_batches_run_seq',
      'ix_discrepancies_validation_status',
      'ix_audit_workspace_date',
    ];

    const allPostIndexes = Array.from(postUpgrade.indexes.values()).flat();
    const allPostIndexNames = new Set(allPostIndexes.map((idx) => idx.index_name));

    for (const idxName of expectedSecondaryIndexes) {
      expect(allPostIndexNames.has(idxName), `Secondary index ${idxName} must exist post-upgrade`).toBe(true);
    }

    for (const tbl of baseline.tables) {
      const baseIdxs = baseline.indexes.get(tbl) || [];
      const postIdxs = postUpgrade.indexes.get(tbl) || [];

      if (tbl === 'migration_batches') {
        // Exactly 1 new index added for uq_migration_batches_identity
        expect(postIdxs.length, 'migration_batches index count').toBe(baseIdxs.length + 1);
        const addedIdx = postIdxs.find((idx) => idx.index_name === 'uq_migration_batches_identity');
        expect(addedIdx, 'uq_migration_batches_identity index must be present').toBeDefined();
        for (const baseIdx of baseIdxs) {
          const postIdx = postIdxs.find((idx) => idx.index_name === baseIdx.index_name);
          expect(postIdx, `Index ${baseIdx.index_name} on ${tbl} must be preserved`).toBeDefined();
          expect(postIdx!.index_definition).toBe(baseIdx.index_definition);
        }
      } else {
        expect(postIdxs.length, `Table ${tbl} index count mismatch`).toBe(baseIdxs.length);
        for (const baseIdx of baseIdxs) {
          const postIdx = postIdxs.find((idx) => idx.index_name === baseIdx.index_name);
          expect(postIdx, `Index ${baseIdx.index_name} on ${tbl} must be preserved`).toBeDefined();
          expect(postIdx!.index_definition).toBe(baseIdx.index_definition);
        }
      }
    }

    // 8. New Archive & Report Table Structure Assertions
    const archiveCols = postUpgrade.columns.get('record_manifest_historical_archive') || [];
    expect(archiveCols.length, 'record_manifest_historical_archive column count').toBe(17);
    const reportCols = postUpgrade.columns.get('manifest_reconciliation_reports') || [];
    expect(reportCols.length, 'manifest_reconciliation_reports column count').toBe(9);
  }

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

  // DDL generator for complete actual Run 005.14 schema (commit 2fdc9e8)
  // Preserves every table, column, default, index, and constraint from historical schema.
  // Single-column FK on migration_batch_id, nullable destination coordinates and batch references,
  // NO uq_migration_batches_identity, NO archive tables, NO composite FK.
  async function createRun00514LegacySchema(client: pg.PoolClient, schemaName: string) {
    await createIsolatedSchema(client, schemaName);
    await client.query(`SET search_path TO ${schemaName}`);

    if (fs.existsSync(run00514DdlPath)) {
      const ddl = fs.readFileSync(run00514DdlPath, 'utf8').replace(/^\uFEFF/, '');
      await client.query(ddl);
    } else {
      throw new Error(`[Test Fixture] Run 005.14 DDL file not found at ${run00514DdlPath}`);
    }
  }

  // Pre-Run 005.14 unconstrained legacy schema:
  // Same complete schema, but without uq_record_manifests_run_source on record_manifests
  async function createPre00514UnconstrainedSchema(client: pg.PoolClient, schemaName: string) {
    await createRun00514LegacySchema(client, schemaName);
    await client.query(`SET search_path TO ${schemaName}`);
    await client.query(`ALTER TABLE record_manifests DROP CONSTRAINT IF EXISTS uq_record_manifests_run_source`);
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

  it('Requirement 1: faithfully upgrades complete Run 005.14 schema fixture, verifies complete schema parity, and preserves all tables/columns', async (ctx) => {
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

    let baselineCatalog: SchemaCatalog;
    const client = await rawPool.connect();
    try {
      // Step 1: Initialize the isolated schema using the actual complete Run 005.14 DDL
      await createRun00514LegacySchema(client, schemaRun00514);

      // Capture complete baseline schema catalog for the isolated Run 005.14 fixture (Run 005.19)
      baselineCatalog = await captureSchemaCatalog(client, schemaRun00514);

      // Verify Run 005.14 baseline state before running migrations:
      // a) Pre-existing tables exist (22 tables)
      const baselineTablesRes = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      `, [schemaRun00514]);
      const baselineTableNames = new Set(baselineTablesRes.rows.map((r: any) => r.table_name));
      expect(baselineTableNames.size).toBe(22);
      expect(baselineTableNames.has('migration_batches')).toBe(true);
      expect(baselineTableNames.has('record_manifests')).toBe(true);
      expect(baselineTableNames.has('discrepancies')).toBe(true);
      expect(baselineTableNames.has('audit_events')).toBe(true);
      expect(baselineTableNames.has('report_artifacts')).toBe(true);
      expect(baselineTableNames.has('ai_traces')).toBe(true);

      // b) Archive and reconciliation tables do NOT exist prior to upgrade
      expect(baselineTableNames.has('record_manifest_historical_archive')).toBe(false);
      expect(baselineTableNames.has('manifest_reconciliation_reports')).toBe(false);

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

      // f) Verify all 16 migration_batches columns exist in Run 005.14
      const mbCols = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'migration_batches'
      `, [schemaRun00514]);
      const mbColNames = new Set(mbCols.rows.map((r: any) => r.column_name));
      expect(mbColNames.has('source_cursor_start')).toBe(true);
      expect(mbColNames.has('source_cursor_end')).toBe(true);
      expect(mbColNames.has('records_read')).toBe(true);
      expect(mbColNames.has('records_written')).toBe(true);
      expect(mbColNames.has('records_skipped')).toBe(true);
      expect(mbColNames.has('records_failed')).toBe(true);
      expect(mbColNames.has('attempt_count')).toBe(true);
      expect(mbColNames.has('started_at')).toBe(true);
      expect(mbColNames.has('completed_at')).toBe(true);
      expect(mbColNames.has('error_summary')).toBe(true);

      // Step 2: Seed canonical relational entities inside the isolated schema
      await client.query(`SET search_path TO ${schemaRun00514}`);

      await client.query(
        `INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)`,
        [workspaceId, `WS ${testSuffix}`, `slug-run00514-${testSuffix}`],
      );
      await client.query(
        `INSERT INTO projects (id, workspace_id, name, description, status) VALUES ($1, $2, 'Upg Project', 'Complete schema test', 'ACTIVE')`,
        [projectId, workspaceId],
      );
      await client.query(
        `INSERT INTO connections (id, workspace_id, name, engine, connection_role, config_json, status)
         VALUES ($1, $2, 'Src', 'MONGODB', 'SOURCE', '{"host":"mongo"}', 'HEALTHY'),
                ($3, $2, 'Dst', 'POSTGRESQL', 'DESTINATION', '{"host":"pg"}', 'HEALTHY')`,
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
        `INSERT INTO migration_batches (id, migration_run_id, batch_key, sequence_no, status, records_read, records_written)
         VALUES ($1, $2, 'batch_00514_01', 1, 'COMMITTED', 100, 100)`,
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

        // =====================================================================
        // Complete Post-Upgrade Schema Fidelity & Catalog Parity Assertions (Run 005.19)
        // =====================================================================
        const postUpgradeCatalog = await captureSchemaCatalog(checkClient, schemaRun00514);
        assertSchemaCatalogParity(baselineCatalog, postUpgradeCatalog, schemaRun00514);

        // =====================================================================
        // Data Integrity & Active Record Resolution Assertions
        // =====================================================================

        // Active records remaining: exactly 4 resolvable records survive
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

        // Unresolvable records archived into record_manifest_historical_archive
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

        // Audit report in manifest_reconciliation_reports
        const reportRes = await checkClient.query(`SELECT * FROM manifest_reconciliation_reports`);
        expect(reportRes.rows.length).toBeGreaterThan(0);
        expect(reportRes.rows[0].archived_record_count).toBe(2);

        // Second run of runMigrations() is 100% idempotent
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
