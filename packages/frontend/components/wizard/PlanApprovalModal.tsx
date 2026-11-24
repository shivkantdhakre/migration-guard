'use client';

import React, { useState } from 'react';
import { ShieldCheck, Check, Hash, Copy, CheckCheck, AlertCircle } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { MigrationPlan } from '../../lib/types';
import { apiClient } from '../../lib/api-client';

export interface PlanApprovalModalProps {
  isOpen: boolean;
  onClose: () => void;
  plan: MigrationPlan | null;
  onApproved: (approvedPlan: MigrationPlan) => void;
}

export function PlanApprovalModal({
  isOpen,
  onClose,
  plan,
  onApproved,
}: PlanApprovalModalProps) {
  const [comment, setComment] = useState('Dry-run completed with zero schema violations. Approved for execution.');
  const [confirmed, setConfirmed] = useState(false);
  const [approving, setApproving] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!plan) return null;

  const handleCopyHash = () => {
    navigator.clipboard?.writeText(plan.planHash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleApprove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmed || approving) return;

    setApproving(true);
    try {
      const versionId = plan.versionId || (Array.isArray(plan.versions) && plan.versions[0]?.id) || plan.id;
      await apiClient.approvePlan(versionId, plan.planHash, comment);
      const updated: MigrationPlan = {
        ...plan,
        status: 'APPROVED',
        approvalComment: comment,
        approvedBy: 'current-user@acme.corp',
        approvedAt: new Date().toISOString(),
      };
      onApproved(updated);
      onClose();
    } catch {
      // Handled
    } finally {
      setApproving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Approve Migration Plan Hash"
      subtitle="Strict cryptographic governance (BR-001 & BR-002)"
      maxWidth="lg"
    >
      <form onSubmit={handleApprove} className="space-y-4">
        {/* Governance banner */}
        <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 space-y-1.5">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldCheck size={16} className="text-emerald-400" />
            <span>Cryptographic Plan Hash Requirement</span>
          </div>
          <p className="text-[11px] text-emerald-300/80 leading-normal">
            Only approved canonical plan hashes can trigger distributed execution runs. Any alteration to mapping, batch sizes, or connection parameters invalidates this hash.
          </p>
        </div>

        {/* Plan Hash Display Box */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs font-mono text-infra-muted">
            <span className="flex items-center gap-1.5 font-medium">
              <Hash size={13} className="text-emerald-400" />
              <span>Canonical SHA-256 Hash:</span>
            </span>
            <button
              type="button"
              onClick={handleCopyHash}
              className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-mono"
            >
              {copied ? <CheckCheck size={12} /> : <Copy size={12} />}
              <span>{copied ? 'Copied' : 'Copy Hash'}</span>
            </button>
          </div>

          <div className="p-3 rounded-lg bg-black/60 border border-infra-border font-mono text-xs text-emerald-300 break-all select-all">
            {plan.planHash}
          </div>
        </div>

        {/* Plan Configuration Summary */}
        <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs space-y-2 font-mono">
          <div className="flex justify-between">
            <span className="text-infra-muted">Plan Name:</span>
            <span className="text-infra-heading font-medium">{plan.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-infra-muted">Batch Size:</span>
            <span className="text-infra-text">{plan.batchSize} records/batch</span>
          </div>
          <div className="flex justify-between">
            <span className="text-infra-muted">Concurrency:</span>
            <span className="text-infra-text">{plan.concurrency} parallel workers</span>
          </div>
          <div className="flex justify-between">
            <span className="text-infra-muted">Write Mode:</span>
            <Badge variant="sky" size="sm">{plan.writeMode}</Badge>
          </div>
        </div>

        {/* Approval Comment */}
        <div>
          <label className="block text-xs font-mono text-infra-text mb-1">
            Approval Justification / Comment (Saved to Audit Log)
          </label>
          <textarea
            rows={2}
            required
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading placeholder-infra-muted focus:outline-none focus:border-emerald-500 font-sans"
          />
        </div>

        {/* Confirmation Checkbox */}
        <div className="flex items-start gap-2.5 pt-1">
          <input
            type="checkbox"
            id="hash-confirm"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5 rounded border-infra-border bg-infra-surface text-emerald-500 focus:ring-0"
          />
          <label htmlFor="hash-confirm" className="text-xs text-infra-text leading-tight cursor-pointer">
            I confirm that I have reviewed the dry-run results, verified the schema mappings, and authorize this exact plan hash for production execution.
          </label>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-infra-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-infra-muted hover:text-infra-heading bg-infra-surface border border-infra-border hover:bg-infra-cardHover transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!confirmed || approving}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-infra-base transition-colors shadow-md shadow-emerald-500/20"
          >
            <ShieldCheck size={14} />
            <span>{approving ? 'Signing Approval...' : 'Approve Plan Hash'}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}
