import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { CryptoUtil } from '../common/crypto/crypto.util';

function escapeHtml(str: any): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeCsvField(val: any): string {
  if (val === null || val === undefined) return '""';
  let s = String(val);
  // Neutralize formula injection prefixes (=, +, -, @, \t, \r)
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

@Injectable()
export class ReportService {
  private inMemoryCache = new Map<string, string>();

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
    let discRes = await this.db.query(
      'SELECT * FROM discrepancies WHERE validation_run_id = $1 ORDER BY severity ASC',
      [validationRunId],
    );
    if (discRes.rows.length === 0) {
      discRes = await this.db.query(
        'SELECT * FROM discrepancy_records WHERE validation_run_id = $1 ORDER BY severity ASC',
        [validationRunId],
      );
    }

    let content = '';
    if (format === 'CSV') {
      content = this.generateCsv(valRun, checksRes.rows, discRes.rows);
    } else {
      content = this.generateHtml(valRun, checksRes.rows, discRes.rows);
    }

    const checksum = CryptoUtil.canonicalHash(content);
    const sizeBytes = Buffer.byteLength(content, 'utf8');

    // Durably persist report bytes to artifact storage (Section 7.1)
    const storageDir = process.env.REPORTS_STORAGE_DIR || path.resolve(process.cwd(), 'storage', 'reports');
    try {
      fs.mkdirSync(storageDir, { recursive: true });
    } catch {
      // Storage directory may already exist
    }

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
        `pending://${validationRunId}`,
        checksum,
        sizeBytes,
        userId,
      ],
    );

    const reportArtifact = reportRes.rows[0];
    const storageFilePath = path.join(storageDir, `${reportArtifact.id}.${format.toLowerCase()}`);

    try {
      fs.writeFileSync(storageFilePath, content, 'utf8');
      const writtenContent = fs.readFileSync(storageFilePath, 'utf8');
      const writtenChecksum = CryptoUtil.canonicalHash(writtenContent);
      if (writtenChecksum !== checksum) {
        throw new Error('Durable report write verification failed: written checksum does not match expected checksum.');
      }
      await this.db.query('UPDATE report_artifacts SET storage_ref = $1 WHERE id = $2', [
        storageFilePath,
        reportArtifact.id,
      ]);
      reportArtifact.storage_ref = storageFilePath;
    } catch (writeErr: any) {
      await this.db.query('UPDATE report_artifacts SET status = $1 WHERE id = $2', ['ERROR', reportArtifact.id]);
      throw new Error(`Failed to persist durable report to storage: ${writeErr.message}`);
    }

    reportArtifact.content = content;
    return reportArtifact;
  }

  async listReports(workspaceId: string, userId: string) {
    await this.workspaceService.assertWorkspaceAccess(workspaceId, userId, 'Viewer');
    const res = await this.db.query(
      'SELECT id, workspace_id, validation_run_id, report_type, format, checksum, created_at FROM report_artifacts WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId],
    );
    return res.rows;
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
    if (!report.storage_ref || !fs.existsSync(report.storage_ref)) {
      throw new NotFoundException(`Durable report artifact ${reportId} not found in persistent storage.`);
    }

    const content = fs.readFileSync(report.storage_ref, 'utf8');

    // Verify stored content matches registered checksum (Section 7.1)
    const currentChecksum = CryptoUtil.canonicalHash(content);
    if (report.checksum && report.checksum !== currentChecksum) {
      throw new ConflictException('Report checksum mismatch: artifact integrity violated.');
    }

    return {
      format: report.format,
      filename: `migrationguard-report-${report.id.slice(0, 8)}.${report.format.toLowerCase()}`,
      content,
      checksum: report.checksum,
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
          `${sanitizeCsvField(c.check_id)},${sanitizeCsvField(c.check_name)},${sanitizeCsvField(c.status)},${c.evaluated_count},${c.passed_count},${c.failed_count},${c.duration_ms}`,
      ),
      '',
      'Section: Discrepancies',
      'Discrepancy ID,Category,Severity,Source Object,Source Key,Status,Summary',
      ...discrepancies.map(
        (d) =>
          `${sanitizeCsvField(d.id)},${sanitizeCsvField(d.category)},${sanitizeCsvField(d.severity)},${sanitizeCsvField(d.source_object || d.source_entity || '')},${sanitizeCsvField(d.source_key_ref || d.source_key || '')},${sanitizeCsvField(d.status)},${sanitizeCsvField(d.summary || JSON.stringify(d.expected_value_json || ''))}`,
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
    <p>Validation Run ID: <code>${escapeHtml(valRun.id)}</code></p>
    <p>Migration Run ID: <code>${escapeHtml(valRun.migration_run_id)}</code></p>
    <p>Status: <strong>${escapeHtml(valRun.status)}</strong></p>
  </div>
  <div class="card">
    <h3>Deterministic Validation Checks</h3>
    <table>
      <thead><tr><th>Check ID</th><th>Name</th><th>Status</th><th>Evaluated</th><th>Passed</th><th>Failed</th></tr></thead>
      <tbody>
        ${checks
          .map(
            (c) =>
              `<tr><td>${escapeHtml(c.check_id)}</td><td>${escapeHtml(c.check_name)}</td><td><span class="badge ${c.status === 'PASS' ? 'badge-pass' : 'badge-fail'}">${escapeHtml(c.status)}</span></td><td>${c.evaluated_count}</td><td>${c.passed_count}</td><td>${c.failed_count}</td></tr>`,
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
              `<tr><td>${escapeHtml(d.category)}</td><td><span class="badge ${d.severity === 'CRITICAL' ? 'badge-crit' : 'badge-high'}">${escapeHtml(d.severity)}</span></td><td>${escapeHtml(d.source_object || d.source_entity || '')}</td><td><code>${escapeHtml(d.source_key_ref || d.source_key || '')}</code></td><td>${escapeHtml(d.summary || JSON.stringify(d.expected_value_json || ''))}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;
  }
}
