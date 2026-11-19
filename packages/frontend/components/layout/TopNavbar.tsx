'use client';

import React from 'react';
import Link from 'next/link';
import {
  Sparkles,
  Search,
  Database,
  ArrowRight,
  GitBranch,
  FolderGit2,
  Bell,
  Terminal,
} from 'lucide-react';
import { SystemHealthBadge } from './SystemHealthBadge';

export interface TopNavbarProps {
  onOpenCopilot: () => void;
  copilotOpen: boolean;
}

export function TopNavbar({ onOpenCopilot, copilotOpen }: TopNavbarProps) {
  return (
    <header className="h-16 border-b border-infra-border bg-infra-surface/80 backdrop-blur-md px-6 flex items-center justify-between z-20 shrink-0">
      {/* Left: Project & Breadcrumbs */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-xs font-mono text-infra-muted">
          <FolderGit2 size={14} className="text-emerald-400" />
          <span className="text-infra-heading font-medium">Acme Corp</span>
          <span>/</span>
          <span className="text-infra-text">mongo-to-pg-production</span>
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">
            git:main#7c1cda
          </span>
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-4">
        {/* System Health */}
        <SystemHealthBadge />

        <div className="h-4 w-px bg-infra-border" />

        {/* AI Copilot Toggle Button */}
        <button
          onClick={onOpenCopilot}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all shadow-sm ${
            copilotOpen
              ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-infra-base font-semibold shadow-emerald-500/25 ring-2 ring-emerald-400/50'
              : 'bg-infra-card border border-infra-border text-emerald-400 hover:border-emerald-500/40 hover:bg-infra-cardHover'
          }`}
        >
          <Sparkles size={14} className={copilotOpen ? 'animate-spin' : ''} />
          <span>AI Copilot</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        </button>

        {/* Guided Wizard CTA */}
        <Link
          href="/wizard"
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors shadow-lg shadow-emerald-500/20"
        >
          <span>Launch Migration</span>
          <ArrowRight size={14} />
        </Link>
      </div>
    </header>
  );
}
