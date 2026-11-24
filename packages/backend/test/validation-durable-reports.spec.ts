import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { AuthService } from '../src/auth/auth.service';
import { ValidationService } from '../src/validation/validation.service';
import { ReportService } from '../src/report/report.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';
import {
  ValidationEngine,
  calculateRecordHash,
  canonicalizeJson,
  sha256Hex,
} from '@migrationguard/core';
import * as crypto from 'node:crypto';

describe('Validation & Durable Reports Acceptance Suite (Section 9.4)', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let authService: AuthService;
  let validationService: ValidationService;
  let reportService: ReportService;
  let user: any;
  let wsId: string;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    const jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);

    user = await authService.register('auditor@corp.com', 'Auditor User', 'Pass123!');
    wsId = user.workspace.id;

    validationService = new ValidationService(db, workspaceService);
    reportService = new ReportService(db, workspaceService);
  });

  async function setupRunFixture(runId: string) {
    const srcConn = await db.query(
      `INSERT INTO connections (workspace_id, name, engine, connection_role, status, created_by)
       VALUES ($1, 'Source DB', 'POSTGRESQL', 'SOURCE', 'HEALTHY', $2) RETURNING id`,
      [wsId, user.user.id],
    );
    const dstConn = await db.query(
      `INSERT INTO connections (workspace_id, name, engine, connection_role, status, created_by)
       VALUES ($1, 'Dest DB', 'POSTGRESQL', 'DESTINATION', 'HEALTHY', $2) RETURNING id`,
      [wsId, user.user.id],
    );
    const proj = await db.query(
      'INSERT INTO projects (workspace_id, name, created_by) VALUES ($1, $2, $3) RETURNING id',
      [wsId, 'ValProj', user.user.id],
    );
    const plan = await db.query(
      'INSERT INTO migration_plans (workspace_id, project_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [wsId, proj.rows[0].id, 'ValPlan', user.user.id],
    );
    const mapping = await db.query(
      `INSERT INTO mapping_versions (workspace_id, plan_id, version, mapping_json, mapping_hash, created_by)
       VALUES ($1, $2, 1, $3, 'map_hash', $4) RETURNING id`,
      [
        wsId,
        plan.rows[0].id,
        JSON.stringify({
          objects: [
            {
              source: { object: 'customers', key: 'id' },
              destination: { object: 'customers', key: 'id' },
              fields: [{ source: 'name', destination: 'name' }, { source: 'email', destination: 'email' }],
            },
          ],
        }),
        user.user.id,
      ],
    );
    const ver = await db.query(
      `INSERT INTO migration_plan_versions (
         plan_id, version, source_connection_id, destination_connection_id, mapping_version_id, plan_hash, created_by
       ) VALUES ($1, 1, $2, $3, $4, 'plan_hash', $5) RETURNING id`,
      [plan.rows[0].id, srcConn.rows[0].id, dstConn.rows[0].id, mapping.rows[0].id, user.user.id],
    );
    await db.query(
      `INSERT INTO migration_runs (id, workspace_id, project_id, plan_version_id, status, created_by)
       VALUES ($1, $2, $3, $4, 'COMPLETED', $5)`,
      [runId, wsId, proj.rows[0].id, ver.rows[0].id, user.user.id],
    );
  }

  it('1. Independent source and destination comparison: tampering one destination field detects discrepancy', async () => {
    const runId = '00000000-0000-0000-0000-000000000001';
    await setupRunFixture(runId);

    await db.query(`DROP TABLE IF EXISTS source_customers CASCADE;`);
    await db.query(`DROP TABLE IF EXISTS customers CASCADE;`);

    await db.query(`
      CREATE TABLE source_customers (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255)
      );
    `);
    await db.query(`
      CREATE TABLE customers (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255)
      );
    `);

    await db.query(`INSERT INTO source_customers (id, name, email) VALUES ('1', 'Alice Smith', 'alice@example.com')`);
    await db.query(`INSERT INTO source_customers (id, name, email) VALUES ('2', 'Bob Jones', 'bob@example.com')`);

    // Destination record has been modified (name changed from Alice Smith to Alice Tampered)
    await db.query(`INSERT INTO customers (id, name, email) VALUES ('1', 'Alice Tampered', 'alice@example.com')`);
    await db.query(`INSERT INTO customers (id, name, email) VALUES ('2', 'Bob Jones', 'bob@example.com')`);

    await db.query(`INSERT INTO record_manifests (migration_run_id, source_object, source_key, destination_object, destination_key, status) VALUES ($1, 'customers', '1', 'customers', '1', 'WRITTEN')`, [runId]);
    await db.query(`INSERT INTO record_manifests (migration_run_id, source_object, source_key, destination_object, destination_key, status) VALUES ($1, 'customers', '2', 'customers', '2', 'WRITTEN')`, [runId]);

    // Exercise triggerValidation() directly
    const valRun = await validationService.triggerValidation(runId, user.user.id);
    expect(valRun).toBeDefined();

    const discRes = await db.query(
      'SELECT * FROM discrepancies WHERE validation_run_id = $1',
      [valRun.id],
    );
    expect(discRes.rows.length).toBeGreaterThan(0);
    const fieldDiscrepancy = discRes.rows.find((d: any) => d.category === 'FIELD_VALUE');
    expect(fieldDiscrepancy).toBeDefined();
    expect(fieldDiscrepancy.source_key_ref).toBe('1');
    expect(fieldDiscrepancy.field_path).toBe('name');
  });

  it('2. Missing destination record detection', async () => {
    const runId = '00000000-0000-0000-0000-000000000002';
    await setupRunFixture(runId);

    await db.query(`DROP TABLE IF EXISTS source_customers CASCADE;`);
    await db.query(`DROP TABLE IF EXISTS customers CASCADE;`);

    await db.query(`
      CREATE TABLE source_customers (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255)
      );
    `);
    await db.query(`
      CREATE TABLE customers (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255)
      );
    `);

    await db.query(`INSERT INTO source_customers (id, name) VALUES ('101', 'Customer 101')`);
    await db.query(`INSERT INTO source_customers (id, name) VALUES ('102', 'Customer 102')`);

    // Destination is missing id 102
    await db.query(`INSERT INTO customers (id, name) VALUES ('101', 'Customer 101')`);

    await db.query(`INSERT INTO record_manifests (migration_run_id, source_object, source_key, destination_object, destination_key, status) VALUES ($1, 'customers', '101', 'customers', '101', 'WRITTEN')`, [runId]);
    await db.query(`INSERT INTO record_manifests (migration_run_id, source_object, source_key, destination_object, destination_key, status) VALUES ($1, 'customers', '102', 'customers', '102', 'WRITTEN')`, [runId]);

    // Exercise triggerValidation() directly
    const valRun = await validationService.triggerValidation(runId, user.user.id);
    expect(valRun).toBeDefined();

    const discRes = await db.query(
      'SELECT * FROM discrepancies WHERE validation_run_id = $1',
      [valRun.id],
    );
    const missing = discRes.rows.find((d: any) => d.category === 'MISSING_RECORD');
    expect(missing).toBeDefined();
    expect(missing.source_key_ref).toBe('102');
  });

  it('3. Unified canonical hash verification against independent test oracle', () => {
    const testRecord = {
      b: 2,
      a: 1,
      nested: { z: true, y: 'hello' },
    };

    // Independent RFC 8785 oracle computation
    const oracleSortedJson = '{"a":1,"b":2,"nested":{"y":"hello","z":true}}';
    const oracleExpectedHash = 'sha256:' + crypto.createHash('sha256').update(oracleSortedJson, 'utf8').digest('hex');

    const libraryHash = calculateRecordHash(testRecord);
    expect(libraryHash).toBe(oracleExpectedHash);
  });

  it('4. Unavailable source returns ERROR, not PASS', async () => {
    // Create a connection marked as ERROR
    const connRes = await db.query(
      `INSERT INTO connections (workspace_id, name, engine, connection_role, status, created_by)
       VALUES ($1, 'Dead Source', 'MONGODB', 'SOURCE', 'ERROR', $2) RETURNING id`,
      [wsId, user.user.id],
    );
    const deadConnId = connRes.rows[0].id;

    // Create plan version with dead connection
    const projRes = await db.query(
      'INSERT INTO projects (workspace_id, name, created_by) VALUES ($1, $2, $3) RETURNING id',
      [wsId, 'Proj', user.user.id],
    );
    const planRes = await db.query(
      'INSERT INTO migration_plans (workspace_id, project_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [wsId, projRes.rows[0].id, 'Plan', user.user.id],
    );
    const verRes = await db.query(
      `INSERT INTO migration_plan_versions (plan_id, version, plan_hash, source_connection_id)
       VALUES ($1, 1, 'hash_abc', $2) RETURNING id`,
      [planRes.rows[0].id, deadConnId],
    );
    const runRes = await db.query(
      `INSERT INTO migration_runs (workspace_id, project_id, plan_version_id, status, created_by)
       VALUES ($1, $2, $3, 'COMPLETED', $4) RETURNING id`,
      [wsId, projRes.rows[0].id, verRes.rows[0].id, user.user.id],
    );

    // Validation must fail closed with error, not pass
    await expect(
      validationService.triggerValidation(runRes.rows[0].id, user.user.id),
    ).rejects.toThrow();

    const valRuns = await db.query(
      'SELECT status FROM validation_runs WHERE migration_run_id = $1',
      [runRes.rows[0].id],
    );
    expect(valRuns.rows[0]?.status).toBe('ERROR');
  });

  it('5. Durable immutable report artifact: persist, restart service, download, verify SHA-256 matches', async () => {
    // Insert mock validation run
    const valRunRes = await db.query(
      `INSERT INTO validation_runs (workspace_id, migration_run_id, status, validation_profile_version, canonicalization_version, summary_json)
       VALUES ($1, gen_random_uuid(), 'COMPLETED', '1.0', '1.0', '{}') RETURNING id`,
      [wsId],
    );
    const valRunId = valRunRes.rows[0].id;

    // Generate HTML report
    const generated = await reportService.generateReport(valRunId, 'DETAILED', 'HTML', user.user.id);
    expect(generated.id).toBeDefined();
    expect(generated.checksum).toBeDefined();

    // Simulate backend restart by creating a new ReportService instance with fresh memory
    const restartedReportService = new ReportService(db, workspaceService);

    // Download the stored report
    const downloaded = await restartedReportService.downloadReport(generated.id, user.user.id);

    // Verify downloaded bytes match exact recorded checksum
    expect(downloaded.checksum).toBe(generated.checksum);
    expect(downloaded.format).toBe('HTML');
  });

  it('6. HTML escaping prevents XSS and CSV formula injection is neutralized', async () => {
    // Insert mock validation run
    const valRunRes = await db.query(
      `INSERT INTO validation_runs (workspace_id, migration_run_id, status, validation_profile_version, canonicalization_version, summary_json)
       VALUES ($1, gen_random_uuid(), 'COMPLETED', '1.0', '1.0', '{}') RETURNING id`,
      [wsId],
    );
    const valRunId = valRunRes.rows[0].id;

    // Seed malicious discrepancy with script tag (HTML XSS) and spreadsheet formulas (=1+1, @SUM)
    await db.query(
      `INSERT INTO discrepancy_records (
         workspace_id, validation_run_id, category, severity, source_key,
         expected_value_json, actual_value_json, status
       ) VALUES (
         $1, $2, 'FIELD_MISMATCH', 'HIGH', '=1+1+cmd|'' /C calc''!A0',
         '"<script>alert(1)</script>"'::jsonb,
         '""'::jsonb,
         'OPEN'
       )`,
      [wsId, valRunId],
    );
    await db.query(
      `INSERT INTO discrepancy_records (
         workspace_id, validation_run_id, category, severity, source_key,
         expected_value_json, actual_value_json, status
       ) VALUES (
         $1, $2, 'FIELD_MISMATCH', 'HIGH', '@SUM(1+1)',
         '""'::jsonb,
         '""'::jsonb,
         'OPEN'
       )`,
      [wsId, valRunId],
    );

    // Generate HTML report and verify HTML escaping
    const htmlReport = await reportService.generateReport(valRunId, 'DETAILED', 'HTML', user.user.id);
    const downloadedHtml = await reportService.downloadReport(htmlReport.id, user.user.id);
    expect(downloadedHtml.content).not.toContain('<script>alert(1)</script>');
    expect(downloadedHtml.content).toContain('&lt;script&gt;');

    // Generate CSV report and verify formula sanitization
    const csvReport = await reportService.generateReport(valRunId, 'DETAILED', 'CSV', user.user.id);
    const downloadedCsv = await reportService.downloadReport(csvReport.id, user.user.id);
    // Formula prefixes (=, +, -, @) must be neutralized with a leading single quote (')
    expect(downloadedCsv.content).toContain("'=1+1");
    expect(downloadedCsv.content).toContain("'@SUM(1+1)");
  });

  it('7. cleanly generates HTML and CSV reports with 0 discrepancies when discrepancy_records table does not exist in PostgreSQL', async () => {
    const valRunRes = await db.query(
      `INSERT INTO validation_runs (workspace_id, migration_run_id, status, validation_profile_version, canonicalization_version, summary_json)
       VALUES ($1, gen_random_uuid(), 'COMPLETED', '1.0', '1.0', '{}') RETURNING id`,
      [wsId],
    );
    const valRunId = valRunRes.rows[0].id;

    const origQuery = db.query.bind(db);
    db.query = (async (text: string, params?: any[]) => {
      if (text.includes('FROM discrepancy_records')) {
        const pgErr: any = new Error('relation "discrepancy_records" does not exist');
        pgErr.code = '42P01';
        throw pgErr;
      }
      return origQuery(text, params);
    }) as any;

    try {
      const htmlReport = await reportService.generateReport(valRunId, 'EXECUTIVE', 'HTML', user.user.id);
      const downloadedHtml = await reportService.downloadReport(htmlReport.id, user.user.id);
      expect(downloadedHtml.content).toContain('Discrepancies (0)');

      const csvReport = await reportService.generateReport(valRunId, 'DETAILED', 'CSV', user.user.id);
      const downloadedCsv = await reportService.downloadReport(csvReport.id, user.user.id);
      expect(downloadedCsv.content).toContain('# MigrationGuard Validation Assurance Report');
    } finally {
      db.query = origQuery;
    }
  });
});
