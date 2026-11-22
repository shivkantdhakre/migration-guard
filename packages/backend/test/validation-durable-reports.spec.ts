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

  it('1. Independent source and destination comparison: tampering one destination field detects discrepancy', async () => {
    const sourceRecords = [
      { id: '1', name: 'Alice Smith', email: 'alice@example.com' },
      { id: '2', name: 'Bob Jones', email: 'bob@example.com' },
    ];

    // Destination record has been modified (name changed from Alice Smith to Alice Tampered)
    const destinationRecords = [
      { id: '1', name: 'Alice Tampered', email: 'alice@example.com' },
      { id: '2', name: 'Bob Jones', email: 'bob@example.com' },
    ];

    const engine = new ValidationEngine({
      migrationRunId: '00000000-0000-0000-0000-000000000001',
      workspaceId: wsId,
      fieldRules: [{ fieldPath: 'name' }, { fieldPath: 'email' }],
    });

    const summary = await engine.validate(
      { objectName: 'customers', records: sourceRecords },
      { objectName: 'customers', records: destinationRecords },
    );

    expect(summary.totalDiscrepancies).toBeGreaterThan(0);
    const fieldDiscrepancy = summary.discrepancies.find((d) => d.category === 'FIELD_VALUE_MISMATCH');
    expect(fieldDiscrepancy).toBeDefined();
    expect(fieldDiscrepancy?.sourceKey).toBe('1');
    expect(fieldDiscrepancy?.expectedValue).toBe('Alice Smith');
    expect(fieldDiscrepancy?.actualValue).toBe('Alice Tampered');
  });

  it('2. Missing destination record detection', async () => {
    const sourceRecords = [
      { id: '101', name: 'Customer 101' },
      { id: '102', name: 'Customer 102' },
    ];
    // Destination is missing id 102
    const destinationRecords = [{ id: '101', name: 'Customer 101' }];

    const engine = new ValidationEngine({
      migrationRunId: '00000000-0000-0000-0000-000000000001',
      workspaceId: wsId,
    });

    const summary = await engine.validate(
      { objectName: 'customers', records: sourceRecords },
      { objectName: 'customers', records: destinationRecords },
    );

    const missing = summary.discrepancies.find((d) => d.category === 'MISSING_RECORD');
    expect(missing).toBeDefined();
    expect(missing?.sourceKey).toBe('102');
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
       VALUES ($1, $2, $3, 'RUNNING', $4) RETURNING id`,
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
});
