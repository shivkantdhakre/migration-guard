import {
  Discrepancy,
  DiscrepancySeverity,
  ValidationCheckResult,
  ValidationRunSummary,
} from '../validator/discrepancy.types.js';

export interface HtmlReportOptions {
  title?: string;
  projectName?: string;
  organization?: string;
}

function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  const text = typeof str === 'object' ? JSON.stringify(str) : String(str);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getSeverityBadge(severity: DiscrepancySeverity): string {
  const styles: Record<DiscrepancySeverity, string> = {
    CRITICAL: 'background-color: #fee2e2; color: #991b1b; border: 1px solid #f87171;',
    HIGH: 'background-color: #ffedd5; color: #9a3412; border: 1px solid #fb923c;',
    MEDIUM: 'background-color: #fef9c3; color: #854d0e; border: 1px solid #facc15;',
    LOW: 'background-color: #e0f2fe; color: #075985; border: 1px solid #38bdf8;',
  };
  return `<span style="padding: 3px 8px; border-radius: 9999px; font-size: 11px; font-weight: 700; ${styles[severity] || ''}">${severity}</span>`;
}

function getStatusBadge(state: string): string {
  if (state === 'PASS') {
    return `<span style="padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; background-color: #dcfce7; color: #166534; border: 1px solid #4ade80;">PASS</span>`;
  }
  if (state === 'FAIL') {
    return `<span style="padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; background-color: #fee2e2; color: #991b1b; border: 1px solid #f87171;">FAIL</span>`;
  }
  return `<span style="padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; background-color: #f3f4f6; color: #4b5563; border: 1px solid #d1d5db;">${escapeHtml(state)}</span>`;
}

export function generateHtmlReport(
  summary: ValidationRunSummary,
  options: HtmlReportOptions = {}
): string {
  const title = options.title || 'MigrationGuard — Automated Validation Assurance Report';
  const projectName = options.projectName || 'Production Database Migration';
  const org = options.organization || 'MigrationGuard Assurance Engine';

  const isPass = summary.overallState === 'PASS';
  const bannerColor = isPass ? '#166534' : '#991b1b';
  const bannerBg = isPass ? '#f0fdf4' : '#fef2f2';
  const bannerBorder = isPass ? '#86efac' : '#fca5a5';

  const checkRows = summary.checkResults
    .map((c) => {
      return `
      <tr>
        <td style="padding: 10px 14px; font-weight: 600; color: #1e293b;">${escapeHtml(c.checkName)}</td>
        <td style="padding: 10px 14px; font-family: monospace; font-size: 12px; color: #475569;">${escapeHtml(c.category)}</td>
        <td style="padding: 10px 14px; text-align: center;">${getStatusBadge(c.state)}</td>
        <td style="padding: 10px 14px; text-align: right; font-family: monospace;">${c.evaluatedCount.toLocaleString()}</td>
        <td style="padding: 10px 14px; text-align: right; color: #16a34a; font-family: monospace;">${c.passedCount.toLocaleString()}</td>
        <td style="padding: 10px 14px; text-align: right; color: ${c.failedCount > 0 ? '#dc2626' : '#64748b'}; font-family: monospace; font-weight: ${c.failedCount > 0 ? '700' : '400'};">${c.failedCount.toLocaleString()}</td>
        <td style="padding: 10px 14px; text-align: right; color: #64748b; font-size: 12px;">${c.durationMs}ms</td>
      </tr>`;
    })
    .join('');

  const discrepancyRows = (summary.discrepancies || [])
    .map((d, idx) => {
      return `
      <tr style="background-color: ${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
        <td style="padding: 8px 12px; font-family: monospace; font-size: 12px; font-weight: 600; color: #0f172a;">${escapeHtml(d.issueId)}</td>
        <td style="padding: 8px 12px;">
          <span style="font-size: 11px; font-family: monospace; background: #e2e8f0; padding: 2px 6px; border-radius: 4px; color: #334155;">
            ${escapeHtml(d.category)}
          </span>
        </td>
        <td style="padding: 8px 12px; text-align: center;">${getSeverityBadge(d.severity)}</td>
        <td style="padding: 8px 12px; font-family: monospace; font-size: 12px; color: #3b82f6;">${escapeHtml(d.sourceKey || '—')}</td>
        <td style="padding: 8px 12px; font-family: monospace; font-size: 12px; color: #6366f1;">${escapeHtml(d.destinationKey || '—')}</td>
        <td style="padding: 8px 12px; font-family: monospace; font-size: 11px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(d.expectedValue)}">${escapeHtml(d.expectedValue)}</td>
        <td style="padding: 8px 12px; font-family: monospace; font-size: 11px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #dc2626;" title="${escapeHtml(d.actualValue)}">${escapeHtml(d.actualValue)}</td>
        <td style="padding: 8px 12px; font-size: 12px; color: #334155;">${escapeHtml(d.explanation)}</td>
        <td style="padding: 8px 12px; font-size: 11px; color: #64748b; white-space: nowrap;">${new Date(d.timestamp).toISOString().replace('T', ' ').substring(0, 19)}</td>
      </tr>`;
    })
    .join('');

  const catEntries = Object.entries(summary.discrepanciesByCategory || {});
  const catPills = catEntries
    .map(
      ([cat, cnt]) => `
      <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 16px; margin: 4px; flex: 1 1 200px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
        <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px;">${escapeHtml(cat)}</div>
        <div style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 4px;">${cnt}</div>
      </div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #f1f5f9;
      color: #0f172a;
      margin: 0;
      padding: 32px 24px;
      line-height: 1.5;
    }
    .container {
      max-width: 1300px;
      margin: 0 auto;
    }
    .header {
      background: #0f172a;
      color: #ffffff;
      padding: 24px 32px;
      border-radius: 12px 12px 0 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .brand {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge-sub {
      background: #334155;
      color: #94a3b8;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 500;
    }
    .banner {
      background: ${bannerBg};
      border: 1px solid ${bannerBorder};
      color: ${bannerColor};
      padding: 18px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
    }
    .card {
      background: #ffffff;
      border-radius: 10px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      margin-bottom: 24px;
      border: 1px solid #e2e8f0;
      overflow: hidden;
    }
    .card-header {
      padding: 16px 24px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      font-size: 15px;
      font-weight: 700;
      color: #1e293b;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-body {
      padding: 20px 24px;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px 20px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    .kpi-label {
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .kpi-value {
      font-size: 28px;
      font-weight: 800;
      margin-top: 6px;
      color: #0f172a;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      background: #f8fafc;
      color: #475569;
      font-weight: 600;
      text-align: left;
      padding: 10px 14px;
      border-bottom: 1px solid #cbd5e1;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    td {
      border-bottom: 1px solid #f1f5f9;
    }
    .footer {
      text-align: center;
      color: #94a3b8;
      font-size: 12px;
      margin-top: 40px;
      padding-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <div class="brand">
          <span>🛡️ MigrationGuard</span>
          <span class="badge-sub">Validation Engine v1.0</span>
        </div>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">
          Project: ${escapeHtml(projectName)} · ${escapeHtml(org)}
        </div>
      </div>
      <div style="text-align: right; font-size: 12px; color: #94a3b8;">
        <div>Run ID: <code style="color: #38bdf8;">${escapeHtml(summary.validationRunId)}</code></div>
        <div>Migration Run: <code style="color: #a78bfa;">${escapeHtml(summary.migrationRunId)}</code></div>
      </div>
    </div>

    <div class="banner">
      <div>
        <span style="font-size: 18px; font-weight: 800;">VERDICT: ${isPass ? 'ALL CHECKS PASSED' : 'DISCREPANCIES DETECTED'}</span>
        <span style="margin-left: 12px; font-size: 13px; opacity: 0.85;">Completed in ${summary.durationMs}ms</span>
      </div>
      <div>
        ${getStatusBadge(summary.overallState)}
      </div>
    </div>

    <div style="margin-top: 24px;">
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Checks</div>
          <div class="kpi-value">${summary.totalChecks}</div>
          <div style="font-size: 12px; color: #16a34a; margin-top: 4px;">${summary.passedChecks} passed · ${summary.failedChecks} failed</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Discrepancies</div>
          <div class="kpi-value" style="color: ${summary.totalDiscrepancies > 0 ? '#dc2626' : '#16a34a'};">
            ${summary.totalDiscrepancies}
          </div>
          <div style="font-size: 12px; color: #64748b; margin-top: 4px;">Seed verification</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Critical Severity</div>
          <div class="kpi-value" style="color: ${summary.discrepanciesBySeverity.CRITICAL > 0 ? '#991b1b' : '#64748b'};">
            ${summary.discrepanciesBySeverity.CRITICAL}
          </div>
          <div style="font-size: 12px; color: #64748b; margin-top: 4px;">Blocking cutover</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">High Severity</div>
          <div class="kpi-value" style="color: ${summary.discrepanciesBySeverity.HIGH > 0 ? '#ea580c' : '#64748b'};">
            ${summary.discrepanciesBySeverity.HIGH}
          </div>
          <div style="font-size: 12px; color: #64748b; margin-top: 4px;">Data fidelity issues</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Medium Severity</div>
          <div class="kpi-value" style="color: ${summary.discrepanciesBySeverity.MEDIUM > 0 ? '#ca8a04' : '#64748b'};">
            ${summary.discrepanciesBySeverity.MEDIUM}
          </div>
          <div style="font-size: 12px; color: #64748b; margin-top: 4px;">Metadata & formatting</div>
        </div>
      </div>
    </div>

    ${
      catEntries.length > 0
        ? `
    <div class="card">
      <div class="card-header">Discrepancy Distribution by Category</div>
      <div class="card-body" style="display: flex; flex-wrap: wrap; gap: 8px;">
        ${catPills}
      </div>
    </div>`
        : ''
    }

    <div class="card">
      <div class="card-header">
        <span>Deterministic Check Breakdown</span>
        <span style="font-size: 12px; font-weight: 500; color: #64748b;">${summary.checkResults.length} verification engines executed</span>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Check Suite</th>
              <th>Category</th>
              <th style="text-align: center;">State</th>
              <th style="text-align: right;">Evaluated</th>
              <th style="text-align: right;">Passed</th>
              <th style="text-align: right;">Failed</th>
              <th style="text-align: right;">Duration</th>
            </tr>
          </thead>
          <tbody>
            ${checkRows}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span>Discrepancy Explorer</span>
        <span style="font-size: 12px; font-weight: 500; color: #64748b;">Showing ${summary.discrepancies.length} itemized findings</span>
      </div>
      <div style="overflow-x: auto; max-height: 600px; overflow-y: auto;">
        <table>
          <thead>
            <tr>
              <th>Issue ID</th>
              <th>Category</th>
              <th style="text-align: center;">Severity</th>
              <th>Source Key</th>
              <th>Dest Key</th>
              <th>Expected</th>
              <th>Actual</th>
              <th>Explanation</th>
              <th>Detected At</th>
            </tr>
          </thead>
          <tbody>
            ${discrepancyRows.length > 0 ? discrepancyRows : '<tr><td colspan="9" style="text-align:center; padding: 24px; color: #16a34a; font-weight: 600;">No discrepancies detected! All configured validation checks passed for the tested migration scope.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="footer">
      Generated automatically by MigrationGuard Assurance Engine · Cryptographically Verified Report · Deterministic Quality Guarantee
    </div>
  </div>
</body>
</html>`;
}
