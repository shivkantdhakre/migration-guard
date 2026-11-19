import React from 'react';
import { ShieldCheck, Cpu } from 'lucide-react';
import { Badge } from '../common/Badge';

export function SystemHealthBadge() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-infra-card border border-infra-border text-xs text-infra-text">
        <Cpu size={14} className="text-emerald-400" />
        <span className="text-infra-muted font-mono">Workers:</span>
        <span className="font-semibold text-emerald-400 font-mono">4/4 Active</span>
      </div>

      <Badge variant="emerald" dot>
        <ShieldCheck size={12} className="inline mr-1" />
        Cluster Healthy
      </Badge>
    </div>
  );
}
