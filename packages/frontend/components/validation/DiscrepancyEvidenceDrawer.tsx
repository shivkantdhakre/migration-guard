'use client';

import React from 'react';
import { Drawer } from '../common/Drawer';
import { Badge } from '../common/Badge';
import { DiscrepancyRecord } from '../../lib/types';
import {
  AlertTriangle,
  ArrowRight,
  Sparkles,
  Copy,
  CheckCheck,
  ShieldAlert,
  FileCode,
} from 'lucide-react';

export interface DiscrepancyEvidenceDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  discrepancy: DiscrepancyRecord | null;
  onOpenCopilotWithContext?: (query: string) => void;
}

export function DiscrepancyEvidenceDrawer({
  isOpen,
  onClose,
  discrepancy,
  onOpenCopilotWithContext,
}: DiscrepancyEvidenceDrawerProps) {
  const [copied, setCopied] = React.useState(false);

  if (!discrepancy) return null;

  const handleCopyId = () => {
    navigator.clipboard?.writeText(discrepancy.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getSeverityBadge = (sev: string) => {
    switch (sev) {
      case 'Critical':
        return <Badge variant="rose">{sev}</Badge>;
      case 'High':
        return <Badge variant="amber">{sev}</Badge>;
      case 'Medium':
        return <Badge variant="sky">{sev}</Badge>;
      default:
        return <Badge variant="slate">{sev}</Badge>;
    }
  };

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title={`Discrepancy Evidence: ${discrepancy.id}`}
      subtitle={`Category: ${discrepancy.category} • Table: ${discrepancy.collectionOrTable}`}
      width="xl"
    >
      <div className="space-y-6">
        {/* Header Badges */}
        <div className="flex items-center justify-between p-3.5 rounded-xl bg-infra-card border border-infra-border">
          <div className="flex items-center gap-2">
            <span className="text-xs text-infra-muted font-mono">Severity:</span>
            {getSeverityBadge(discrepancy.severity)}
            <Badge variant="purple" size="sm">{discrepancy.status}</Badge>
          </div>

          <button
            onClick={handleCopyId}
            className="flex items-center gap-1 text-[11px] font-mono text-infra-muted hover:text-emerald-400 transition-colors"
          >
            {copied ? <CheckCheck size={12} /> : <Copy size={12} />}
            <span>{copied ? 'Copied ID' : 'Copy Evidence ID'}</span>
          </button>
        </div>

        {/* Identifiers & Coordinates */}
        <div className="grid grid-cols-2 gap-3 p-4 rounded-xl bg-infra-surface border border-infra-border font-mono text-xs">
          <div>
            <span className="text-infra-muted block text-[10px] uppercase tracking-wider mb-1">Source Record Key</span>
            <span className="text-infra-heading font-semibold select-all bg-black/40 px-2 py-1 rounded border border-infra-border block truncate">
              {discrepancy.sourceKey}
            </span>
          </div>

          <div>
            <span className="text-infra-muted block text-[10px] uppercase tracking-wider mb-1">Destination Key</span>
            <span className="text-emerald-400 font-semibold select-all bg-black/40 px-2 py-1 rounded border border-infra-border block truncate">
              {discrepancy.destinationKey}
            </span>
          </div>

          {discrepancy.fieldOrPath && (
            <div className="col-span-2 pt-2 border-t border-infra-border/50">
              <span className="text-infra-muted text-[10px] uppercase tracking-wider mr-2">Evaluated Field Path:</span>
              <span className="text-sky-300 font-mono font-medium">{discrepancy.fieldOrPath}</span>
            </div>
          )}
        </div>

        {/* Deterministic Explanation */}
        <div className="p-4 rounded-xl bg-infra-card border border-infra-border space-y-2">
          <h4 className="text-xs font-semibold text-infra-heading font-mono flex items-center gap-1.5">
            <ShieldAlert size={14} className="text-amber-400" />
            <span>Deterministic Validator Finding</span>
          </h4>
          <p className="text-xs text-infra-text leading-relaxed font-sans">{discrepancy.explanation}</p>
        </div>

        {/* Expected vs Actual Diff Comparison */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-infra-heading font-mono flex items-center gap-1.5">
            <FileCode size={14} className="text-emerald-400" />
            <span>Exact State Comparison</span>
          </h4>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <span className="text-[11px] font-mono text-emerald-400 font-semibold">Expected State</span>
              <pre className="p-3 rounded-lg bg-black/60 border border-emerald-500/30 text-[11px] font-mono text-emerald-300 overflow-x-auto h-32">
                <code>{typeof discrepancy.expectedValue === 'object' ? JSON.stringify(discrepancy.expectedValue, null, 2) : String(discrepancy.expectedValue)}</code>
              </pre>
            </div>

            <div className="space-y-1.5">
              <span className="text-[11px] font-mono text-rose-400 font-semibold">Actual State Found</span>
              <pre className="p-3 rounded-lg bg-black/60 border border-rose-500/30 text-[11px] font-mono text-rose-300 overflow-x-auto h-32">
                <code>{discrepancy.actualValue === null ? 'null (missing/empty)' : typeof discrepancy.actualValue === 'object' ? JSON.stringify(discrepancy.actualValue, null, 2) : String(discrepancy.actualValue)}</code>
              </pre>
            </div>
          </div>
        </div>

        {/* AI Copilot Deep Dive Action */}
        <div className="p-4 rounded-xl bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border border-emerald-500/30 flex items-center justify-between">
          <div>
            <h5 className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
              <Sparkles size={14} />
              <span>Investigate with AI Copilot</span>
            </h5>
            <p className="text-[11px] text-infra-muted mt-0.5">
              Synthesize root cause and generate an allowlisted repair plan for this discrepancy.
            </p>
          </div>

          <button
            onClick={() => {
              onClose();
              if (onOpenCopilotWithContext) {
                onOpenCopilotWithContext(`Please investigate discrepancy ${discrepancy.id} (${discrepancy.category}) for ${discrepancy.sourceKey}`);
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors shrink-0 shadow-md shadow-emerald-500/20"
          >
            <span>Ask Copilot</span>
            <ArrowRight size={13} />
          </button>
        </div>
      </div>
    </Drawer>
  );
}
