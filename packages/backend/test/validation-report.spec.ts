import { describe, it, expect, beforeEach } from 'vitest';
import { ValidationService } from '../src/validation/validation.service';
import { DiscrepancyService } from '../src/validation/discrepancy.service';
import { ReportService } from '../src/report/report.service';
import { WorkspaceService } from '../src/workspace/workspace.service';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';

describe('Validation & Report Generation', () => {
  let db: DatabaseService;
  let workspaceService: WorkspaceService;
  let validationService: ValidationService;
  let discrepancyService: DiscrepancyService;
  let reportService: ReportService;
  let authService: AuthService;
  let user: any;
  let runId: string;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    workspaceService = new WorkspaceService(db);
    validationService = new ValidationService(db, workspaceService);
    discrepancyService = new DiscrepancyService(db);
    reportService = new ReportService(db, workspaceService);

    const jwt = new JwtService({ secret: appConfig.jwtSecret });
    authService = new AuthService(db, jwt);

    user = await authService.register('auditor@corp.com', 'QA Lead', 'AuditPass123!');
    const wsId = user.workspace.id;

    // Seed mock project, plan, version, and run
    const projRes = await db.query(
      'INSERT INTO projects (workspace_id, name) VALUES ($1, $2) RETURNING id',
      [wsId, 'Assurance Project'],
    );
    const planRes = await db.query(
      'INSERT INTO migration_plans (workspace_id, project_id, name) VALUES ($1, $2, $3) RETURNING id',
      [wsId, projRes.rows[0].id, 'Plan 1'],
    );
    const versionRes = await db.query(
      `INSERT INTO migration_plan_versions (
         plan_id, version, source_connection_id, destination_connection_id, plan_hash
       ) VALUES ($1, 1, $2, $3, 'sha256:abc') RETURNING id`,
      [planRes.rows[0].id, 'conn_1', 'conn_2'],
    );
    const runRes = await db.query(
      `INSERT INTO migration_runs (workspace_id, project_id, plan_version_id, status)
       VALUES ($1, $2, $3, 'COMPLETED') RETURNING id`,
      [wsId, projRes.rows[0].id, versionRes.rows[0].id],
    );
    runId = runRes.rows[0].id;
  });

  it('should trigger validation run, store checks and discrepancies, and filter them', async () => {
    const valRun = await validationService.triggerValidation(runId, user.user.id);
    expect(valRun.id).toBeDefined();
    expect(valRun.status).toBe('COMPLETED');

    // 1. Checks breakdown
    const checks = await validationService.getCheckResults(valRun.id, user.user.id);
    expect(checks.length).toBe(9);
    const countCheck = checks.find((c: any) => c.check_id === 'CHK-001');
    expect(countCheck.status).toBe('PASS');

    // 2. Discrepancies listing and filters
    const allDiscrepancies = await discrepancyService.listDiscrepancies(valRun.id);
    expect(allDiscrepancies.discrepancies.length).toBeGreaterThan(0);

    const attachmentDiscrepancies = await discrepancyService.listDiscrepancies(valRun.id, {
      category: 'ATTACHMENT',
    });
    expect(attachmentDiscrepancies.discrepancies.length).toBe(1);
    expect(attachmentDiscrepancies.discrepancies[0].category).toBe('ATTACHMENT');

    // 3. Update discrepancy status
    const discId = attachmentDiscrepancies.discrepancies[0].id;
    const updated = await discrepancyService.updateDiscrepancyStatus(
      discId,
      'ACKNOWLEDGED',
      'Investigating MinIO bucket sync lag',
    );
    expect(updated.status).toBe('ACKNOWLEDGED');
    expect(updated.summary).toContain('Investigating MinIO bucket sync lag');
  });

  it('should generate and download CSV and HTML reports', async () => {
    const valRun = await validationService.triggerValidation(runId, user.user.id);

    // 1. Generate HTML report
    const htmlReport = await reportService.generateReport(
      valRun.id,
      'DETAILED',
      'HTML',
      user.user.id,
    );
    expect(htmlReport.id).toBeDefined();
    expect(htmlReport.format).toBe('HTML');
    expect(htmlReport.content).toContain('<!DOCTYPE html>');
    expect(htmlReport.content).toContain('MigrationGuard Assurance Report');
    expect(htmlReport.content).toContain('CHK-001');

    // 2. Generate CSV report
    const csvReport = await reportService.generateReport(valRun.id, 'DETAILED', 'CSV', user.user.id);
    expect(csvReport.format).toBe('CSV');
    expect(csvReport.content).toContain('# MigrationGuard Validation Assurance Report');
    expect(csvReport.content).toContain('Check ID,Check Name,Status');

    // 3. Download report file
    const download = await reportService.downloadReport(htmlReport.id, user.user.id);
    expect(download.filename).toMatch(/\.html$/);
    expect(download.content).toBe(htmlReport.content);
  });
});
