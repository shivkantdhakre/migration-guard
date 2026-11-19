'use client';

import React from 'react';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { GitCompare, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';

export interface SnapshotDiffModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceSnapshotName: string;
  targetSnapshotName: string;
}

export function SnapshotDiffModal({
  isOpen,
  onClose,
  sourceSnapshotName,
  targetSnapshotName,
}: SnapshotDiffModalProps) {
  const diffRows = [
    {
      sourceField: '_id (ObjectId)',
      targetField: 'source_id (VARCHAR(64))',
      status: 'MATCHED',
      strategy: 'PRESERVE_AS_TEXT',
      lossRisk: 'NONE',
    },
    {
      sourceField: 'name (string)',
      targetField: 'name (VARCHAR(255))',
      status: 'MATCHED',
      strategy: 'TRIM_STRING',
      lossRisk: 'NONE',
    },
    {
      sourceField: 'email (string)',
      targetField: 'email (VARCHAR(255) UNIQUE)',
      status: 'MATCHED',
      strategy: 'LOWERCASE',
      lossRisk: 'NONE',
    },
    {
      sourceField: 'createdAt (Date | ISO)',
      targetField: 'created_at (TIMESTAMPTZ)',
      status: 'CONVERTED',
      strategy: 'PARSE_TIMESTAMP (AUTO_ISO_OR_EPOCH)',
      lossRisk: 'LOW',
    },
    {
      sourceField: 'address (embedded object)',
      targetField: 'address (JSONB)',
      status: 'NORMALIZED',
      strategy: 'TO_JSONB',
      lossRisk: 'NONE',
    },
    {
      sourceField: 'orders[] (embedded array)',
      targetField: 'public.orders (normalized child table)',
      status: 'RELATIONAL_NORMALIZED',
      strategy: 'ARRAY_TO_CHILD_ROWS',
      lossRisk: 'PARENT_KEY_INTEGRITY_REQUIRED',
    },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Schema Snapshot Diff & Type Compatibility"
      subtitle={`Comparing ${sourceSnapshotName} against ${targetSnapshotName}`}
      maxWidth="xl"
    >
      <div className="space-y-4">
        {/* Compatibility Summary Banner */}
        <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2 text-emerald-300">
            <CheckCircle2 size={16} className="text-emerald-400" />
            <span>100% Structural Coverage Verified • 0 Blocking Type Incompatibilities</span>
          </div>
          <Badge variant="emerald" size="sm">FR-SCH-005</Badge>
        </div>

        {/* Diff Table */}
        <div className="rounded-xl border border-infra-border overflow-hidden">
          <table className="w-full text-left border-collapse text-xs font-mono">
            <thead>
              <tr className="bg-infra-surface border-b border-infra-border text-infra-muted text-[11px]">
                <th className="py-2.5 px-3">Source Field (Mongo)</th>
                <th className="py-2.5 px-3">Target Column (Postgres)</th>
                <th className="py-2.5 px-3">Transform Strategy</th>
                <th className="py-2.5 px-3">Risk Assessment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-infra-border bg-infra-card">
              {diffRows.map((row, idx) => (
                <tr key={idx} className="hover:bg-infra-cardHover/50 transition-colors">
                  <td className="py-2.5 px-3 text-infra-heading font-medium">{row.sourceField}</td>
                  <td className="py-2.5 px-3 text-emerald-400 font-medium">{row.targetField}</td>
                  <td className="py-2.5 px-3">
                    <span className="px-2 py-0.5 rounded bg-infra-surface border border-infra-border text-[11px] text-sky-300">
                      {row.strategy}
                    </span>
                  </td>
                  <td className="py-2.5 px-3">
                    <Badge
                      variant={row.lossRisk === 'NONE' ? 'emerald' : 'amber'}
                      size="sm"
                    >
                      {row.lossRisk}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Close button */}
        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-infra-card border border-infra-border hover:bg-infra-cardHover text-infra-text transition-colors"
          >
            Close Diff
          </button>
        </div>
      </div>
    </Modal>
  );
}
