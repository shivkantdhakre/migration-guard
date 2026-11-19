import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { CryptoUtil } from '../common/crypto/crypto.util';

@Injectable()
export class ReportService {
  constructor(
    private db: DatabaseService,
    private workspaceService: WorkspaceService,
  ) {}

  async generateReport(
    validationRunId: string,
    reportType: 'EXECUTIVE' | 'DETAILED' | 'AUDIT' = 'DETAILED',
    format: 'HTML' | 'CSV' = 'HTML',
    userId: string,
  ) {
    const valRes = await this.db.query('SELECT * FROM validation_runs WHERE id = $1', [validationRunId]);
    if (valRes.rows.length === 0) {
      throw new NotFoundException('Validation run not found.');
    }
    const valRun = valRes.rows[0];
    await this.workspaceService.assertWorkspaceAccess(valRun.workspace_id, userId, 'Viewer');

    // Fetch checks and discrepancies
    const checksRes = await this.db.query(
      'SELECT * FROM validation_check_results WHERE validation_run_id = $1 ORDER BY check_id ASC',
      [validationRunId],
    );
    const discRes = await this.db.query(
      'SELECT * FROM discrepancies WHERE validation_run_id = $1 ORDER BY severity ASC',
      [validationRunId],
    );

    let content = '';
    if (format === 'CSV') {
      content = this.generateCsv(valRun, checksRes.rows, discRes.rows);
    } else {
      content = this.generateHtml(valRun, checksRes.rows, discRes.rows);
    }

    const checksum = CryptoUtil.canonicalHash(content);
    const sizeBytes = Buffer.byteLength(content, 'utf8');

    // Store report artifact metadata
    const reportRes = await this.db.query(
      `INSERT INTO report_artifacts (
         workspace_id, validation_run_id, migration_run_id,
         report_type, format, storage_ref, checksum, size_bytes, status, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'COMPLETED', $9)
       RETURNING *`,
      [
        valRun.workspace_id,
        validationRunId,
        valRun.migration_run_id,
        reportType,
        format,
        `memory://reports/${valRun.id}_${Date.now()}.${format.toLowerCase()}`,
        checksum,
        sizeBytes,
        userId,
      ],
    );

    const reportArtifact = reportRes.rows[0];
    // Cache generated content in artifact row for easy download
    reportArtifact.content = content;

    return reportArtifact;
  }

  async getReport(reportId: string, userId: string) {
    const res = await this.db.query('SELECT * FROM report_artifacts WHERE id = $1', [reportId]);
    if (res.rows.length === 0) {
      throw new NotFoundException('Report artifact not found.');
    }
    const report = res.rows[0];
    await this.workspaceService.assertWorkspaceAccess(report.workspace_id, userId, 'Viewer');
    return report;
  }

  async downloadReport(reportId: string, userId: string) {
    const report = await this.getReport(reportId, userId);
    if (!report.content) {
      // Re-generate on demand
      const re = await this.generateReport(
        report.validation_run_id,
        report.report_type as any,
        report.format as any,
        userId,
      );
      report.content = re.content;
    }
    return {
      format: report.format,
      filename: `migrationguard-report-${report.id.slice(0, 8)}.${report.format.toLowerCase()}`,
      content: report.content,
    };
  }

  private generateCsv(valRun: any, checks: any[], discrepancies: any[]): string {
    const lines = [
      '# MigrationGuard Validation Assurance Report',
      `# ValidationRunID: ${valRun.id}`,
      `# MigrationRunID: ${valRun.migration_run_id}`,
      `# GeneratedAt: ${new Date().toISOString()}`,
      '',
      'Section: Check Results',
      'Check ID,Check Name,Status,Evaluated,Passed,Failed,Duration (ms)',
      ...checks.map(
        (c) =>
          `"${c.check_id}","${c.check_name}","${c.status}",${c.evaluated_count},${c.passed_count},${c.failed_count},${c.duration_ms}`,
      ),
      '',
      'Section: Discrepancies',
      'Discrepancy ID,Category,Severity,Source Object,Source Key,Status,Summary',
      ...discrepancies.map(
        (d) =>
          `"${d.id}","${d.category}","${d.severity}","${d.source_object}","${d.source_key_ref}","${d.status}","${d.summary.replace(/"/g, '""')}"`,
      ),
    ];
    return lines.join('\n');
  }

  private generateHtml(valRun: any, checks: any[], discrepancies: any[]): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>MigrationGuard Validation Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 30px; }
    h1 { color: #38bdf8; }
    .card { background: #1e293b; border-radius: 8px; padding: 20px; margin-bottom: 24px; border: 1px solid #334155; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #334155; font-size: 14px; }
    th { background: #0f172a; color: #94a3b8; }
    .badge { padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; }
    .badge-pass { background: #065f46; color: #34d399; }
    .badge-fail { background: #991b1b; color: #f87171; }
    .badge-crit { background: #7f1d1d; color: #fca5a5; }
    .badge-high { background: #9a3412; color: #fdba74; }
  </style>
</head>
<body>
  <h1>MigrationGuard Assurance Report</h1>
  <div class="card">
    <h3>Executive Summary</h3>
    <p>Validation Run ID: <code>${valRun.id}</code></p>
    <p>Migration Run ID: <code>${valRun.migration_run_id}</code></p>
    <p>Status: <strong>${valRun.status}</strong></p>
  </div>
  <div class="card">
    <h3>Deterministic Validation Checks</h3>
    <table>
      <thead><tr><th>Check ID</th><th>Name</th><th>Status</th><th>Evaluated</th><th>Passed</th><th>Failed</th></tr></thead>
      <tbody>
        ${checks
          .map(
            (c) =>
              `<tr><td>${c.check_id}</td><td>${c.check_name}</td><td><span class="badge ${c.status === 'PASS' ? 'badge-pass' : 'badge-fail'}">${c.status}</span></td><td>${c.evaluated_count}</td><td>${c.passed_count}</td><td>${c.failed_count}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>
  <div class="card">
    <h3>Discrepancies (${discrepancies.length})</h3>
    <table>
      <thead><tr><th>Category</th><th>Severity</th><th>Source Entity</th><th>Source Key</th><th>Summary</th></tr></thead>
      <tbody>
        ${discrepancies
          .map(
            (d) =>
              `<tr><td>${d.category}</td><td><span class="badge ${d.severity === 'CRITICAL' ? 'badge-crit' : 'badge-high'}">${d.severity}</span></td><td>${d.source_object}</td><td><code>${d.source_key_ref}</code></td><td>${d.summary}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;
  }
}
