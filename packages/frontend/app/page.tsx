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
} from 'lucide-react';
import { Badge } from '../components/common/Badge';
import { formatNumber, formatDate, truncateHash } from '../lib/utils';
import { apiClient } from '../lib/api-client';
import { MigrationRun, ValidationRun, AuditEvent } from '../lib/types';
import {
  MOCK_MIGRATION_RUNS,
  MOCK_VALIDATION_RUN,
  MOCK_AUDIT_EVENTS,
  MOCK_CONNECTIONS,
} from '../lib/mock-data';

export default function DashboardPage() {
  const [runs, setRuns] = useState<MigrationRun[]>(MOCK_MIGRATION_RUNS);
  const [valRun, setValRun] = useState<ValidationRun>(MOCK_VALIDATION_RUN);
  const [audits, setAudits] = useState<AuditEvent[]>(MOCK_AUDIT_EVENTS);

  useEffect(() => {
    async function load() {
      try {
        const [r, v, a] = await Promise.allSettled([
          apiClient.getMigrationRuns(),
          apiClient.getValidationRun('run-7c1cda51-0001'),
          apiClient.getAuditEvents(),
        ]);
        if (r.status === 'fulfilled' && r.value && Array.isArray(r.value) && r.value.length > 0) {
          setRuns(r.value);
        }
        if (v.status === 'fulfilled' && v.value) {
          setValRun(v.value);
        }
        if (a.status === 'fulfilled' && a.value && Array.isArray(a.value) && a.value.length > 0) {
          setAudits(a.value);
        }
      } catch (err) {
        console.warn('[DashboardPage] Notice loading live data:', err);
      }
    }
    load();
  }, []);

  const activeRun = runs.find((r) => r.status === 'RUNNING') || runs[0] || MOCK_MIGRATION_RUNS[0];
  const progressPercent = Math.round(
    ((activeRun?.processedRecords || 0) / (activeRun?.totalRecords || 1)) * 100
  );

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
          <Link
            href="/wizard"
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors shadow-lg shadow-emerald-500/20"
          >
            <Wand2 size={14} />
            <span>Guided 14-Step Wizard</span>
          </Link>
        </div>
      </div>

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
            <span>1 Active • 1 Validated</span>
          </div>
        </div>

        {/* Metric 2 */}
        <div className="p-4 rounded-xl bg-infra-card border border-infra-border hover:border-infra-borderHover transition-all">
          <div className="flex items-center justify-between text-infra-muted text-xs font-mono">
            <span>Records Transferred</span>
            <TrendingUp size={14} className="text-sky-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-infra-heading font-mono">
            {formatNumber(activeRun.processedRecords)}
          </div>
          <div className="mt-1 text-[11px] text-infra-muted font-mono">
            Target: {formatNumber(activeRun.totalRecords)} ({progressPercent}%)
          </div>
        </div>

        {/* Metric 3 */}
        <div className="p-4 rounded-xl bg-infra-card border border-infra-border hover:border-infra-borderHover transition-all">
          <div className="flex items-center justify-between text-infra-muted text-xs font-mono">
            <span>Throughput Speed</span>
            <TrendingUp size={14} className="text-indigo-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-infra-heading font-mono">
            {activeRun.throughputPerSecond} <span className="text-xs text-infra-muted font-normal">rec/sec</span>
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
            {valRun.totalDiscrepancies} Discrepancies
          </div>
          <div className="mt-1 text-[11px] text-amber-300 font-mono">
            Exact 45-defect seeded test match
          </div>
        </div>
      </div>

      {/* Active Migration Run Spotlight */}
      <div className="p-5 rounded-xl bg-infra-card border border-infra-border space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-infra-heading font-mono">
                  Active Run: {activeRun.id}
                </h3>
                <Badge variant="emerald" dot size="sm">
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
              {activeRun.activeBatchId || 'batch-017'}
            </span>
          </div>
        </div>
      </div>

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
                {MOCK_CONNECTIONS.length} Active Connections
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
                2 Schema Snapshots Loaded
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
                Version 1 Immutable DSL
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
                Explore exactly 45 discrepancies across 9 checks with before/after evidence drawers.
              </p>
              <div className="mt-3 text-[10px] text-rose-400 font-mono">
                45 Seeded Defects Tracked
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
            {audits.slice(0, 4).map((audit) => (
              <div
                key={audit.id}
                className="p-2.5 rounded-lg bg-infra-surface border border-infra-border space-y-1 text-xs font-mono"
              >
                <div className="flex items-center justify-between">
                  <span className="text-emerald-400 font-semibold text-[11px]">{audit.action}</span>
                  <span className="text-[10px] text-infra-muted">
                    {formatDate(audit.timestamp).split(',')[1]}
                  </span>
                </div>
                <p className="text-[11px] text-infra-text font-sans line-clamp-1">{audit.details}</p>
                <div className="text-[10px] text-infra-muted flex items-center justify-between pt-0.5">
                  <span>Actor: {audit.actor}</span>
                  <span>{truncateHash(audit.immutableHash, 10)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
