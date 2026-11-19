'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  Play,
  Pause,
  Square,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Clock,
  Filter,
  Layers,
  ChevronRight,
  TrendingUp,
} from 'lucide-react';
import { Badge } from '../../components/common/Badge';
import { MigrationRun, MigrationBatch, BatchStatus } from '../../lib/types';
import { MOCK_MIGRATION_RUNS, MOCK_BATCHES } from '../../lib/mock-data';
import { apiClient } from '../../lib/api-client';
import { formatNumber, formatDate, truncateHash } from '../../lib/utils';

export default function MigrationExecutionPage() {
  const [runs, setRuns] = useState<MigrationRun[]>(MOCK_MIGRATION_RUNS);
  const [selectedRun, setSelectedRun] = useState<MigrationRun>(MOCK_MIGRATION_RUNS[0]);
  const [batches, setBatches] = useState<MigrationBatch[]>(MOCK_BATCHES);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const data = await apiClient.getMigrationRuns();
        if (data && Array.isArray(data) && data.length > 0) {
          setRuns(data);
          setSelectedRun(data[0]);
          const b = await apiClient.getMigrationBatches(data[0].id);
          if (b && Array.isArray(b)) {
            setBatches(b);
          }
        }
      } catch (err) {
        console.warn('[MigrationExecutionPage] Notice loading runs:', err);
      }
    }
    load();
  }, []);

  const handlePause = async () => {
    setActionLoading(true);
    await apiClient.pauseRun(selectedRun.id);
    setSelectedRun((prev) => ({ ...prev, status: 'PAUSED' }));
    setActionMessage('Migration run pause requested. Current batches completing.');
    setActionLoading(false);
    setTimeout(() => setActionMessage(null), 3000);
  };

  const handleResume = async () => {
    setActionLoading(true);
    await apiClient.resumeRun(selectedRun.id);
    setSelectedRun((prev) => ({ ...prev, status: 'RUNNING' }));
    setActionMessage('Migration run resumed from last committed checkpoint.');
    setActionLoading(false);
    setTimeout(() => setActionMessage(null), 3000);
  };

  const handleCancel = async () => {
    setActionLoading(true);
    await apiClient.cancelRun(selectedRun.id);
    setSelectedRun((prev) => ({ ...prev, status: 'CANCELLED' }));
    setActionMessage('Migration run cancelled. State durably accounted for in manifest.');
    setActionLoading(false);
    setTimeout(() => setActionMessage(null), 3000);
  };

  const handleRetry = async () => {
    setActionLoading(true);
    await apiClient.retryFailedBatches(selectedRun.id);
    setActionMessage('Transient failure retried. Segregated dead-letter queue records queued.');
    setActionLoading(false);
    setTimeout(() => setActionMessage(null), 3000);
  };

  const filteredBatches = batches.filter(
    (b) => statusFilter === 'ALL' || b.status === statusFilter
  );

  const progressPercent = Math.round(
    ((selectedRun?.processedRecords || 0) / (selectedRun?.totalRecords || 1)) * 100
  );

  const getBatchBadgeVariant = (status: BatchStatus) => {
    switch (status) {
      case 'COMMITTED':
        return 'emerald';
      case 'RUNNING':
        return 'sky';
      case 'QUEUED':
      case 'PENDING':
        return 'slate';
      case 'RETRY_WAIT':
        return 'amber';
      case 'FAILED_RETRYABLE':
      case 'FAILED_PERMANENT':
      case 'OUTCOME_UNKNOWN':
        return 'rose';
      default:
        return 'slate';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-infra-heading tracking-tight flex items-center gap-2">
            <span>Migration Execution & Batch Monitor</span>
            <Badge variant="emerald" dot size="sm">
              Live Stream
            </Badge>
          </h1>
          <p className="text-xs text-infra-muted mt-1 font-mono">
            Bounded memory streaming, cursor checkpoints, and distributed batch states (FR-EXEC-001..007)
          </p>
        </div>

        {/* Lifecycle Actions */}
        <div className="flex items-center gap-2">
          {selectedRun.status === 'RUNNING' ? (
            <button
              onClick={handlePause}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-mono font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 transition-colors"
            >
              <Pause size={13} />
              <span>Pause Run</span>
            </button>
          ) : selectedRun.status === 'PAUSED' ? (
            <button
              onClick={handleResume}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors"
            >
              <Play size={13} />
              <span>Resume Run</span>
            </button>
          ) : null}

          <button
            onClick={handleRetry}
            disabled={actionLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-infra-card border border-infra-border hover:border-emerald-500/40 text-emerald-400 transition-colors"
          >
            <RotateCcw size={13} />
            <span>Retry Failed</span>
          </button>

          <button
            onClick={handleCancel}
            disabled={actionLoading || selectedRun.status === 'CANCELLED'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 transition-colors"
          >
            <Square size={12} />
            <span>Cancel Run</span>
          </button>
        </div>
      </div>

      {actionMessage && (
        <div className="p-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-300 font-mono flex items-center gap-2">
          <CheckCircle2 size={16} className="text-emerald-400" />
          <span>{actionMessage}</span>
        </div>
      )}

      {/* Primary Execution Progress Card */}
      <div className="p-6 rounded-xl bg-infra-card border border-infra-border space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-bold text-infra-heading font-mono">
                {selectedRun.id}
              </h2>
              <Badge variant="emerald" dot size="sm">
                {selectedRun.status}
              </Badge>
              <span className="text-xs text-infra-muted font-mono">
                Plan Hash: {truncateHash(selectedRun.planHash, 20)}
              </span>
            </div>
            <p className="text-xs text-infra-muted font-mono mt-1">
              Started: {selectedRun.startedAt ? formatDate(selectedRun.startedAt) : 'N/A'} • Active Target: public.customers
            </p>
          </div>

          <div className="text-right font-mono">
            <span className="text-2xl font-bold text-emerald-400">
              {selectedRun.throughputPerSecond}
            </span>
            <span className="text-xs text-infra-muted block">records / second</span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-infra-text">
              Processed {formatNumber(selectedRun.processedRecords)} of {formatNumber(selectedRun.totalRecords)} records
            </span>
            <span className="text-emerald-400 font-bold">{progressPercent}%</span>
          </div>
          <div className="w-full h-2.5 rounded-full bg-infra-surface overflow-hidden border border-infra-border">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Four Status Counter Tiles */}
        <div className="grid grid-cols-4 gap-3 text-center text-xs font-mono">
          <div className="p-3 rounded-lg bg-infra-surface border border-infra-border">
            <span className="text-infra-muted text-[10px] block uppercase">Committed Rows</span>
            <span className="text-emerald-400 font-bold text-base">
              {formatNumber(selectedRun.succeededRecords)}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-infra-surface border border-infra-border">
            <span className="text-infra-muted text-[10px] block uppercase">Failed / Segregated</span>
            <span className="text-rose-400 font-bold text-base">
              {selectedRun.failedRecords}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-infra-surface border border-infra-border">
            <span className="text-infra-muted text-[10px] block uppercase">Skipped Records</span>
            <span className="text-infra-muted font-bold text-base">
              {selectedRun.skippedRecords}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-infra-surface border border-infra-border">
            <span className="text-infra-muted text-[10px] block uppercase">Active Batch Index</span>
            <span className="text-sky-400 font-bold text-base">
              {selectedRun.activeBatchId || 'batch-017'}
            </span>
          </div>
        </div>
      </div>

      {/* Batch Inspector Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers size={16} className="text-emerald-400" />
            <h2 className="text-sm font-bold text-infra-heading font-mono uppercase tracking-wider">
              Batch Inspector & Manifest Log ({filteredBatches.length} Batches)
            </h2>
          </div>

          {/* Filter Pills */}
          <div className="flex items-center gap-1.5">
            {['ALL', 'COMMITTED', 'RUNNING', 'QUEUED'].map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-mono border transition-all ${
                  statusFilter === st
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                    : 'bg-infra-card border-infra-border text-infra-muted hover:border-infra-borderHover'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>

        {/* Batches Table */}
        <div className="rounded-xl border border-infra-border overflow-hidden bg-infra-card shadow-sm">
          <table className="w-full text-left border-collapse text-xs font-mono">
            <thead>
              <tr className="bg-infra-surface border-b border-infra-border text-infra-muted text-[11px]">
                <th className="py-2.5 px-3">Batch ID</th>
                <th className="py-2.5 px-3">Collection</th>
                <th className="py-2.5 px-3">Cursor Range</th>
                <th className="py-2.5 px-3">Records</th>
                <th className="py-2.5 px-3">Written</th>
                <th className="py-2.5 px-3">Failed</th>
                <th className="py-2.5 px-3">Latency</th>
                <th className="py-2.5 px-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-infra-border">
              {filteredBatches.map((batch) => (
                <tr key={batch.id} className="hover:bg-infra-cardHover/50 transition-colors">
                  <td className="py-3 px-3 font-semibold text-infra-heading">
                    {batch.id}
                  </td>
                  <td className="py-3 px-3 text-infra-text">
                    {batch.collectionName}
                  </td>
                  <td className="py-3 px-3 text-infra-muted text-[11px]">
                    {batch.cursorStart} → {batch.cursorEnd}
                  </td>
                  <td className="py-3 px-3 text-infra-text font-medium">
                    {batch.recordsCount}
                  </td>
                  <td className="py-3 px-3 text-emerald-400 font-medium">
                    {batch.writtenCount}
                  </td>
                  <td className="py-3 px-3 text-rose-400 font-medium">
                    {batch.failedCount}
                  </td>
                  <td className="py-3 px-3 text-infra-muted text-[11px]">
                    {batch.latencyMs}ms
                  </td>
                  <td className="py-3 px-3">
                    <Badge variant={getBatchBadgeVariant(batch.status)} size="sm">
                      {batch.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
