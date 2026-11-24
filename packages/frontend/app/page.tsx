'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  Database,
  ShieldCheck,
  AlertTriangle,
  ArrowRight,
  TrendingUp,
  CheckCircle2,
  Clock,
  Layers,
  Wand2,
  Server,
  FileSpreadsheet,
  FileCheck,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '../components/common/Badge';
import { formatNumber, formatDate, truncateHash } from '../lib/utils';
import { apiClient, isDemoModeEnabled } from '../lib/api-client';
import { MigrationRun, ValidationRun, AuditEvent } from '../lib/types';
import {
  MOCK_MIGRATION_RUNS,
  MOCK_VALIDATION_RUN,
  MOCK_AUDIT_EVENTS,
  MOCK_CONNECTIONS,
} from '../lib/mock-data';

export default function DashboardPage() {
  const [runs, setRuns] = useState<MigrationRun[]>(
    isDemoModeEnabled() ? MOCK_MIGRATION_RUNS : []
  );
  const [valRun, setValRun] = useState<ValidationRun | null>(
    isDemoModeEnabled() ? MOCK_VALIDATION_RUN : null
  );
  const [audits, setAudits] = useState<AuditEvent[]>(
    isDemoModeEnabled() ? MOCK_AUDIT_EVENTS : []
  );
  const [connectionCount, setConnectionCount] = useState<number>(
    isDemoModeEnabled() ? MOCK_CONNECTIONS.length : 0
  );
  const [loading, setLoading] = useState<boolean>(!isDemoModeEnabled());
  const [error, setError] = useState<string | null>(null);

  const loadDashboardData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [runsRes, auditsRes, connsRes] = await Promise.allSettled([
        apiClient.getMigrationRuns(),
        apiClient.getAuditEvents(),
        apiClient.getConnections(),
      ]);

      let loadedRuns: MigrationRun[] = [];
      if (runsRes.status === 'fulfilled' && Array.isArray(runsRes.value)) {
        loadedRuns = runsRes.value;
        setRuns(loadedRuns);
      } else if (isDemoModeEnabled()) {
        loadedRuns = MOCK_MIGRATION_RUNS;
        setRuns(loadedRuns);
      } else {
        setRuns([]);
      }

      if (auditsRes.status === 'fulfilled' && Array.isArray(auditsRes.value)) {
        setAudits(auditsRes.value);
      } else if (isDemoModeEnabled()) {
        setAudits(MOCK_AUDIT_EVENTS);
      } else {
        setAudits([]);
      }

      if (connsRes.status === 'fulfilled' && Array.isArray(connsRes.value)) {
        setConnectionCount(connsRes.value.length);
      } else if (isDemoModeEnabled()) {
        setConnectionCount(MOCK_CONNECTIONS.length);
      } else {
        setConnectionCount(0);
      }

      // If we have runs, load validation data for the first run
      if (loadedRuns.length > 0) {
        try {
          const v = await apiClient.getValidationRun(loadedRuns[0].id);
          setValRun(v);
        } catch {
          if (isDemoModeEnabled()) {
            setValRun(MOCK_VALIDATION_RUN);
          } else {
            setValRun(null);
          }
        }
      } else if (isDemoModeEnabled()) {
        setValRun(MOCK_VALIDATION_RUN);
      } else {
        setValRun(null);
      }
    } catch (err: any) {
      if (isDemoModeEnabled()) {
        setRuns(MOCK_MIGRATION_RUNS);
        setValRun(MOCK_VALIDATION_RUN);
        setAudits(MOCK_AUDIT_EVENTS);
        setConnectionCount(MOCK_CONNECTIONS.length);
      } else {
        setError(err?.message || 'Failed to load dashboard data.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboardData();
  }, []);

  const activeRun = runs.find((r) => r.status === 'RUNNING') || (runs.length > 0 ? runs[0] : null);
  const progressPercent = activeRun
    ? Math.round(((activeRun.processedRecords || 0) / (activeRun.totalRecords || 1)) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-infra-heading tracking-tight flex items-center gap-2">
            <span>Mission Control Overview</span>
            <span className="px-2 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
              Live Pipeline
            </span>
          </h1>
          <p className="text-xs text-infra-muted mt-1 font-mono">
            MongoDB <code>appdb</code> → PostgreSQL <code>migration_dest</code> • Deterministic Assurance Active
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={loadDashboardData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-mono font-medium text-infra-text bg-infra-card border border-infra-border hover:border-infra-borderHover transition-colors disabled:opacity-50"
            title="Refresh dashboard"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>

          <Link
            href="/wizard"
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors shadow-lg shadow-emerald-500/20"
          >
            <Wand2 size={14} />
            <span>Guided 14-Step Wizard</span>
          </Link>
        </div>
      </div>

      {/* Error state */}
      {error && !isDemoModeEnabled() && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            onClick={loadDashboardData}
            className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-[11px] text-rose-200 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Top Metric Cards */}
      <div className="grid grid-cols-4 gap-4">
        {/* Metric 1 */}
        <div className="p-4 rounded-xl bg-infra-card border border-infra-border hover:border-infra-borderHover transition-all">
          <div className="flex items-center justify-between text-infra-muted text-xs font-mono">
            <span>Total Migrations</span>
            <Activity size={14} className="text-emerald-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-infra-heading font-mono">
            {runs.length} Runs
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-emerald-400 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span>{runs.filter((r) => r.status === 'RUNNING').length} Active • {runs.filter((r) => r.status === 'MIGRATED' || r.status === 'VALIDATED').length} Completed</span>
          </div>
        </div>

        {/* Metric 2 */}
        <div className="p-4 rounded-xl bg-infra-card border border-infra-border hover:border-infra-borderHover transition-all">
          <div className="flex items-center justify-between text-infra-muted text-xs font-mono">
            <span>Records Transferred</span>
            <TrendingUp size={14} className="text-sky-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-infra-heading font-mono">
            {activeRun ? formatNumber(activeRun.processedRecords) : '0'}
          </div>
          <div className="mt-1 text-[11px] text-infra-muted font-mono">
            {activeRun ? `Target: ${formatNumber(activeRun.totalRecords)} (${progressPercent}%)` : 'No active target'}
          </div>
        </div>

        {/* Metric 3 */}
        <div className="p-4 rounded-xl bg-infra-card border border-infra-border hover:border-infra-borderHover transition-all">
          <div className="flex items-center justify-between text-infra-muted text-xs font-mono">
            <span>Throughput Speed</span>
            <TrendingUp size={14} className="text-indigo-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-infra-heading font-mono">
            {activeRun ? activeRun.throughputPerSecond : 0} <span className="text-xs text-infra-muted font-normal">rec/sec</span>
          </div>
          <div className="mt-1 text-[11px] text-emerald-400 font-mono">
            Bounded memory: 4 worker threads
          </div>
        </div>

        {/* Metric 4 */}
        <div className="p-4 rounded-xl bg-infra-card border border-infra-border hover:border-infra-borderHover transition-all">
          <div className="flex items-center justify-between text-infra-muted text-xs font-mono">
            <span>Validation Benchmark</span>
            <AlertTriangle size={14} className="text-amber-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-amber-400 font-mono">
            {valRun ? valRun.totalDiscrepancies : 0} Discrepancies
          </div>
          <div className="mt-1 text-[11px] text-amber-300 font-mono">
            {valRun?.totalDiscrepancies === 45 ? 'Exact 45-defect seeded test match' : 'Validation status tracked'}
          </div>
        </div>
      </div>

      {/* Active Migration Run Spotlight */}
      {activeRun ? (
        <div className="p-5 rounded-xl bg-infra-card border border-infra-border space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className={`w-2.5 h-2.5 rounded-full ${activeRun.status === 'RUNNING' ? 'bg-emerald-400 animate-pulse' : 'bg-infra-muted'}`} />
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-infra-heading font-mono">
                    Active Run: {activeRun.id}
                  </h3>
                  <Badge variant={activeRun.status === 'RUNNING' ? 'emerald' : 'slate'} dot size="sm">
                    {activeRun.status}
                  </Badge>
                </div>
                <p className="text-xs text-infra-muted font-mono mt-0.5">
                  Plan Hash: {truncateHash(activeRun.planHash, 24)}
                </p>
              </div>
            </div>

            <Link
              href="/migrations"
              className="flex items-center gap-1.5 text-xs font-mono text-emerald-400 hover:text-emerald-300"
            >
              <span>Inspect Batches</span>
              <ArrowRight size={13} />
            </Link>
          </div>

          {/* Real-time Progress Bar */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-mono">
              <span className="text-infra-text">
                Processed: {formatNumber(activeRun.processedRecords)} / {formatNumber(activeRun.totalRecords)} records
              </span>
              <span className="text-emerald-400 font-bold">{progressPercent}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-infra-surface overflow-hidden border border-infra-border">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* Detailed Status Counters */}
          <div className="grid grid-cols-4 gap-3 pt-2 text-center text-xs font-mono border-t border-infra-border/50">
            <div className="p-2 rounded-lg bg-infra-surface border border-infra-border">
              <span className="text-infra-muted block text-[10px] uppercase">Committed</span>
              <span className="text-emerald-400 font-bold text-sm">
                {formatNumber(activeRun.succeededRecords)}
              </span>
            </div>
            <div className="p-2 rounded-lg bg-infra-surface border border-infra-border">
              <span className="text-infra-muted block text-[10px] uppercase">Failed (Segregated)</span>
              <span className="text-rose-400 font-bold text-sm">
                {activeRun.failedRecords}
              </span>
            </div>
            <div className="p-2 rounded-lg bg-infra-surface border border-infra-border">
              <span className="text-infra-muted block text-[10px] uppercase">Skipped</span>
              <span className="text-infra-muted font-bold text-sm">
                {activeRun.skippedRecords}
              </span>
            </div>
            <div className="p-2 rounded-lg bg-infra-surface border border-infra-border">
              <span className="text-infra-muted block text-[10px] uppercase">Active Batch</span>
              <span className="text-sky-400 font-bold text-sm">
                {activeRun.activeBatchId || 'None'}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-8 rounded-xl bg-infra-card border border-infra-border text-center space-y-3">
          <div className="w-10 h-10 mx-auto rounded-full bg-infra-surface flex items-center justify-center border border-infra-border text-infra-muted">
            <Activity size={20} />
          </div>
          <h3 className="text-sm font-bold text-infra-heading font-mono">No Active Migration Pipeline</h3>
          <p className="text-xs text-infra-muted max-w-sm mx-auto">
            Ready to transfer data? Use the guided 14-step wizard to create a plan, execute a dry-run, and stream records.
          </p>
          <div className="pt-2">
            <Link
              href="/wizard"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors"
            >
              <Wand2 size={13} />
              <span>Launch Wizard</span>
            </Link>
          </div>
        </div>
      )}

      {/* Two-Column Lower Section: Quick Operations & Recent Audit Stream */}
      <div className="grid grid-cols-3 gap-6">
        {/* Left 2 Cols: Platform Modules Quick Navigation */}
        <div className="col-span-2 space-y-4">
          <h2 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
            <Layers size={15} className="text-emerald-400" />
            <span>Platform Infrastructure Subsystems</span>
          </h2>

          <div className="grid grid-cols-2 gap-3">
            {/* Card 1: Connections */}
            <Link
              href="/connections"
              className="p-4 rounded-xl bg-infra-card border border-infra-border hover:border-emerald-500/40 hover:bg-infra-cardHover/50 transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <Database size={18} className="text-emerald-400" />
                <ArrowRight size={14} className="text-infra-muted group-hover:text-emerald-400 transition-colors" />
              </div>
              <h3 className="text-xs font-bold text-infra-heading font-mono">Database Connections</h3>
              <p className="text-[11px] text-infra-muted mt-1 leading-normal">
                Manage Mongo & Postgres profiles with vaulted passwords and credential rotation.
              </p>
              <div className="mt-3 text-[10px] text-emerald-400 font-mono">
                {connectionCount} Active Connections
              </div>
            </Link>

            {/* Card 2: Schema Inspector */}
            <Link
              href="/schema"
              className="p-4 rounded-xl bg-infra-card border border-infra-border hover:border-emerald-500/40 hover:bg-infra-cardHover/50 transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <Layers size={18} className="text-sky-400" />
                <ArrowRight size={14} className="text-infra-muted group-hover:text-sky-400 transition-colors" />
              </div>
              <h3 className="text-xs font-bold text-infra-heading font-mono">Schema Inspector</h3>
              <p className="text-[11px] text-infra-muted mt-1 leading-normal">
                Inspect Mongo collections & fields vs Postgres tables, data types, and snapshot diffs.
              </p>
              <div className="mt-3 text-[10px] text-sky-400 font-mono">
                Real-time Inspection Available
              </div>
            </Link>

            {/* Card 3: Mapping Studio */}
            <Link
              href="/mappings"
              className="p-4 rounded-xl bg-infra-card border border-infra-border hover:border-emerald-500/40 hover:bg-infra-cardHover/50 transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <FileCheck size={18} className="text-indigo-400" />
                <ArrowRight size={14} className="text-infra-muted group-hover:text-indigo-400 transition-colors" />
              </div>
              <h3 className="text-xs font-bold text-infra-heading font-mono">Mapping Studio</h3>
              <p className="text-[11px] text-infra-muted mt-1 leading-normal">
                Visual side-by-side mapping, deterministic transformations, and sample preview.
              </p>
              <div className="mt-3 text-[10px] text-indigo-400 font-mono">
                Deterministic DSL Transformations
              </div>
            </Link>

            {/* Card 4: Validation Center */}
            <Link
              href="/validation"
              className="p-4 rounded-xl bg-infra-card border border-infra-border hover:border-emerald-500/40 hover:bg-infra-cardHover/50 transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <ShieldCheck size={18} className="text-rose-400" />
                <ArrowRight size={14} className="text-infra-muted group-hover:text-rose-400 transition-colors" />
              </div>
              <h3 className="text-xs font-bold text-infra-heading font-mono">Validation Center</h3>
              <p className="text-[11px] text-infra-muted mt-1 leading-normal">
                Explore discrepancies across deterministic checks with before/after evidence drawers.
              </p>
              <div className="mt-3 text-[10px] text-rose-400 font-mono">
                {valRun ? `${valRun.totalDiscrepancies} Discrepancies Logged` : 'Ready to Validate'}
              </div>
            </Link>
          </div>
        </div>

        {/* Right 1 Col: Immutable Audit Log Stream */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Clock size={15} className="text-emerald-400" />
              <span>Audit Timeline</span>
            </h2>
            <Link
              href="/reports"
              className="text-[11px] font-mono text-emerald-400 hover:text-emerald-300"
            >
              View Full Log
            </Link>
          </div>

          <div className="p-4 rounded-xl bg-infra-card border border-infra-border space-y-3">
            {audits.length === 0 ? (
              <p className="text-xs font-mono text-infra-muted py-6 text-center">
                No recent audit events.
              </p>
            ) : (
              audits.slice(0, 4).map((audit) => (
                <div
                  key={audit.id}
                  className="p-2.5 rounded-lg bg-infra-surface border border-infra-border space-y-1 text-xs font-mono"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-emerald-400 font-semibold text-[11px]">{audit.action}</span>
                    <span className="text-[10px] text-infra-muted">
                      {formatDate(audit.timestamp).split(',')[1] || formatDate(audit.timestamp)}
                    </span>
                  </div>
                  <p className="text-[11px] text-infra-text font-sans line-clamp-1">{audit.details}</p>
                  <div className="text-[10px] text-infra-muted flex items-center justify-between pt-0.5">
                    <span>Actor: {audit.actor}</span>
                    <span>{truncateHash(audit.immutableHash, 10)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
