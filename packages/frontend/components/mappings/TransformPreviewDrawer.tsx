'use client';

import React from 'react';
import { Drawer } from '../common/Drawer';
import { Badge } from '../common/Badge';
import { ArrowRight, Check, Sparkles } from 'lucide-react';

export interface TransformPreviewDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  previewData?: {
    source: any;
    transformed: any;
    transformStepsApplied: { field: string; op: string; before: any; after: any }[];
  } | null;
}

export function TransformPreviewDrawer({
  isOpen,
  onClose,
  previewData,
}: TransformPreviewDrawerProps) {
  if (!previewData) return null;

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title="Deterministic Transform Sample Preview"
      subtitle="Evaluated on bounded in-memory sample document (FR-MAP-004)"
      width="2xl"
    >
      <div className="space-y-6">
        {/* Applied Transformations Overview */}
        <div className="p-4 rounded-xl bg-infra-card border border-infra-border space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-infra-heading font-mono flex items-center gap-2">
              <Sparkles size={14} className="text-emerald-400" />
              <span>Applied Transformation Pipeline</span>
            </h4>
            <Badge variant="emerald" size="sm">Deterministic & Audited</Badge>
          </div>

          <div className="space-y-2">
            {previewData.transformStepsApplied.map((step, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-2 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono"
              >
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400 font-bold">{step.field}</span>
                  <Badge variant="sky" size="sm">{step.op}</Badge>
                </div>
                <div className="flex items-center gap-2 text-infra-muted text-[11px]">
                  <span className="line-through text-rose-400/80">{String(step.before)}</span>
                  <ArrowRight size={12} className="text-infra-border" />
                  <span className="text-emerald-300 font-semibold">{String(step.after)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Side-by-Side Before & After JSON */}
        <div className="grid grid-cols-2 gap-4">
          {/* Source Document */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-semibold text-infra-muted">Source (MongoDB Document)</span>
              <Badge variant="slate" size="sm">BSON / JSON</Badge>
            </div>
            <pre className="p-4 rounded-xl bg-black/60 border border-infra-border text-[11px] text-infra-text font-mono overflow-x-auto leading-relaxed h-[360px]">
              <code>{JSON.stringify(previewData.source, null, 2)}</code>
            </pre>
          </div>

          {/* Transformed Destination Record */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-semibold text-emerald-400">Destination (PostgreSQL Row)</span>
              <Badge variant="emerald" size="sm">Typed Relational</Badge>
            </div>
            <pre className="p-4 rounded-xl bg-black/60 border border-emerald-500/30 text-[11px] text-emerald-200 font-mono overflow-x-auto leading-relaxed h-[360px]">
              <code>{JSON.stringify(previewData.transformed, null, 2)}</code>
            </pre>
          </div>
        </div>

        {/* Guardrail Note */}
        <p className="text-[11px] text-infra-muted font-mono text-center">
          Sample preview executes allowlisted pure functions only. Destination database has not been touched.
        </p>
      </div>
    </Drawer>
  );
}
