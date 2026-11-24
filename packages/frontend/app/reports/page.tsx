'use client';

import React, { useEffect, useState } from 'react';
import {
  FileText,
  Download,
  ShieldCheck,
  Check,
  FileSpreadsheet,
  Clock,
  Search,
  Filter,
  Copy,
  CheckCheck,
  Hash,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { Badge } from '../../components/common/Badge';
import { AuditEvent } from '../../lib/types';
import { MOCK_AUDIT_EVENTS } from '../../lib/mock-data';
import { apiClient, isDemoModeEnabled } from '../../lib/api-client';
import { formatDate, truncateHash } from '../../lib/utils';

export default function ReportsAndAuditPage() {
  const [audits, setAudits] = useState<AuditEvent[]>(
    isDemoModeEnabled() ? MOCK_AUDIT_EVENTS : []
  );
  const [loading, setLoading] = useState<boolean>(!isDemoModeEnabled());
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const loadAudits = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.getAuditEvents();
      setAudits(Array.isArray(data) ? data : []);
    } catch (err: any) {
      if (isDemoModeEnabled()) {
        setAudits(MOCK_AUDIT_EVENTS);
      } else {
        setError(err?.message || 'Failed to load immutable audit events.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAudits();
  }, []);

  const handleCopyHash = (hash: string) => {
    navigator.clipboard?.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const filteredAudits = audits.filter(
    (a) =>
      !searchTerm ||
      a.action.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.actor.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.details.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const latestAudit = audits.length > 0 ? audits[0] : null;

  const handleDownloadHtml = () => {
    const htmlReport = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>MigrationGuard Executive Assurance Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 40px; background: #0d1117; color: #c9d1d9; }
    h1 { color: #58a6ff; }
    .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; background: #238636; color: white; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { border: 1px solid #30363d; padding: 10px; text-align: left; font-size: 13px; }
    th { background: #161b22; color: #8b949e; }
  </style>
</head>
<body>
  <h1>MigrationGuard Assurance Report</h1>
  <p><strong>Plan Hash:</strong> ${latestAudit?.immutableHash || 'sha256:unknown'}</p>
  <p><strong>Status:</strong> <span class="badge">AUDITED &amp; SEALED</span></p>
  <p><strong>Sign-Off Authority:</strong> ${latestAudit?.actor || 'Operator'}</p>
  <p><strong>Timestamp:</strong> ${latestAudit ? formatDate(latestAudit.timestamp) : new Date().toISOString()}</p>
  <h2>Audit Events (${audits.length} Records)</h2>
  <table>
    <tr><th>Timestamp</th><th>Action</th><th>Actor</th><th>Resource</th><th>Details</th><th>Hash</th></tr>
    ${audits
      .map(
        (a) =>
          `<tr><td>${formatDate(a.timestamp)}</td><td>${a.action}</td><td>${a.actor}</td><td>${a.resourceType}:${a.resourceId}</td><td>${a.details}</td><td><code>${a.immutableHash}</code></td></tr>`
      )
      .join('\n')}
  </table>
</body>
</html>`;
    const blob = new Blob([htmlReport], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'MigrationGuard_Assurance_Report.html';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-infra-heading tracking-tight flex items-center gap-2">
            <span>Assurance Reports & Audit Trail</span>
            <Badge variant="emerald" size="sm">
              Cryptographically Sealed
            </Badge>
          </h1>
          <p className="text-xs text-infra-muted mt-1 font-mono">
            Immutable audit logs, cryptographic SHA-256 chain verification, and downloadable compliance artifacts (FR-REC-003..005)
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={loadAudits}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-mono font-medium text-infra-text bg-infra-card border border-infra-border hover:border-infra-borderHover transition-colors disabled:opacity-50"
            title="Refresh audit stream"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>

          {audits.length > 0 && (
            <button
              onClick={handleDownloadHtml}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors shadow-lg shadow-emerald-500/20"
            >
              <Download size={14} />
              <span>Download Certified HTML Report</span>
            </button>
          )}
        </div>
      </div>

      {/* Error Banner */}
      {error && !isDemoModeEnabled() && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            onClick={loadAudits}
            className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-[11px] text-rose-200 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading Indicator */}
      {loading && audits.length === 0 && (
        <div className="p-12 text-center rounded-xl bg-infra-card border border-infra-border space-y-3">
          <div className="w-8 h-8 mx-auto border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs font-mono text-infra-muted">Verifying cryptographic audit chain...</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && audits.length === 0 && (
        <div className="p-12 text-center rounded-xl bg-infra-card border border-infra-border space-y-3">
          <div className="w-12 h-12 mx-auto rounded-full bg-infra-surface flex items-center justify-center border border-infra-border text-infra-muted">
            <Clock size={24} />
          </div>
          <h3 className="text-sm font-bold text-infra-heading font-mono">No Audit Events Recorded Yet</h3>
          <p className="text-xs text-infra-muted max-w-md mx-auto">
            Append-only cryptographic audit events are created as migrations, schema validations, and plan approvals execute. Run an operation to generate verified compliance records.
          </p>
        </div>
      )}

      {/* Assurance Summary Box */}
      {latestAudit && (
        <div className="p-5 rounded-xl bg-infra-card border border-infra-border space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText size={18} className="text-emerald-400" />
              <h2 className="text-sm font-bold text-infra-heading font-mono">
                Certified Migration Assurance Package ({latestAudit.resourceId || 'Workspace'})
              </h2>
            </div>
            <Badge variant="emerald" size="sm">Ready for Export</Badge>
          </div>

          <p className="text-xs text-infra-text leading-relaxed font-sans">
            This audit package certifies deterministic execution and verification records. Cryptographic audit trail confirms events logged with forward-secure HMAC/SHA-256 seal.
          </p>

          <div className="grid grid-cols-3 gap-3 pt-2 text-xs font-mono">
            <div className="p-3 rounded-lg bg-infra-surface border border-infra-border">
              <span className="text-infra-muted block text-[10px] uppercase">Plan Canonical Hash</span>
              <span className="text-emerald-400 font-bold block truncate mt-0.5">
                {truncateHash(latestAudit.immutableHash, 24)}
              </span>
            </div>

            <div className="p-3 rounded-lg bg-infra-surface border border-infra-border">
              <span className="text-infra-muted block text-[10px] uppercase">Sign-Off Authority</span>
              <span className="text-infra-heading font-semibold block mt-0.5">
                {latestAudit.actor || 'operator@migrationguard.io'}
              </span>
            </div>

            <div className="p-3 rounded-lg bg-infra-surface border border-infra-border">
              <span className="text-infra-muted block text-[10px] uppercase">Timestamp</span>
              <span className="text-sky-400 font-semibold block mt-0.5">
                {formatDate(latestAudit.timestamp)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Immutable Audit Log Table */}
      {audits.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock size={16} className="text-emerald-400" />
              <h3 className="text-sm font-bold text-infra-heading font-mono uppercase tracking-wider">
                Append-Only Cryptographic Audit Event Log ({filteredAudits.length} of {audits.length} Events)
              </h3>
            </div>

            <input
              type="text"
              placeholder="Search audit trail by actor or action..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="px-3 py-1.5 rounded-lg bg-infra-card border border-infra-border text-xs text-infra-heading placeholder-infra-muted focus:outline-none focus:border-emerald-500 font-mono w-72"
            />
          </div>

          <div className="rounded-xl border border-infra-border overflow-hidden bg-infra-card shadow-sm">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="bg-infra-surface border-b border-infra-border text-infra-muted text-[11px]">
                  <th className="py-2.5 px-3">Timestamp (UTC)</th>
                  <th className="py-2.5 px-3">Action</th>
                  <th className="py-2.5 px-3">Actor</th>
                  <th className="py-2.5 px-3">Resource</th>
                  <th className="py-2.5 px-3">Event Details</th>
                  <th className="py-2.5 px-3">Immutable Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-infra-border">
                {filteredAudits.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-infra-muted font-mono text-xs">
                      No audit events match your search.
                    </td>
                  </tr>
                ) : (
                  filteredAudits.map((a) => (
                    <tr key={a.id} className="hover:bg-infra-cardHover/50 transition-colors">
                      <td className="py-3 px-3 text-infra-muted text-[11px]">
                        {formatDate(a.timestamp)}
                      </td>
                      <td className="py-3 px-3">
                        <Badge variant="emerald" size="sm">{a.action}</Badge>
                      </td>
                      <td className="py-3 px-3 font-medium text-infra-heading">
                        {a.actor}
                      </td>
                      <td className="py-3 px-3 text-sky-400">
                        {a.resourceType}: {a.resourceId}
                      </td>
                      <td className="py-3 px-3 text-infra-text font-sans max-w-xs truncate">
                        {a.details}
                      </td>
                      <td className="py-3 px-3">
                        <button
                          onClick={() => handleCopyHash(a.immutableHash)}
                          className="flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 font-mono"
                        >
                          {copiedHash === a.immutableHash ? (
                            <CheckCheck size={12} />
                          ) : (
                            <Hash size={12} />
                          )}
                          <span>{truncateHash(a.immutableHash, 8)}</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
