'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Database,
  GitCompare,
  Workflow,
  Wand2,
  Activity,
  ShieldCheck,
  FileText,
  Terminal,
  Layers,
  Sparkles,
} from 'lucide-react';
import { cn } from '../../lib/utils';

export function AppSidebar() {
  const pathname = usePathname() || '/';

  const navItems = [
    {
      title: 'Core Engine',
      items: [
        { href: '/', label: 'Dashboard', icon: LayoutDashboard },
        { href: '/connections', label: 'Connections', icon: Database },
        { href: '/schema', label: 'Schema Inspector', icon: Layers },
        { href: '/mappings', label: 'Mapping Studio', icon: GitCompare },
      ],
    },
    {
      title: 'Operations',
      items: [
        { href: '/wizard', label: 'Migration Wizard', icon: Wand2, highlight: true },
        { href: '/migrations', label: 'Execution & Batches', icon: Activity },
        { href: '/validation', label: 'Validation Center', icon: ShieldCheck, badge: '45 issues' },
        { href: '/reports', label: 'Reports & Audit', icon: FileText },
      ],
    },
  ];

  return (
    <aside className="w-64 border-r border-infra-border bg-infra-surface flex flex-col shrink-0 select-none">
      {/* Brand Header */}
      <div className="h-16 flex items-center px-6 border-b border-infra-border gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/20 text-infra-base font-bold text-lg font-mono">
          MG
        </div>
        <div>
          <h1 className="text-sm font-bold text-infra-heading tracking-tight flex items-center gap-1.5">
            MigrationGuard
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
              v0.1
            </span>
          </h1>
          <p className="text-[11px] text-infra-muted font-mono">Enterprise Data Assurance</p>
        </div>
      </div>

      {/* Navigation Sections */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-6">
        {navItems.map((section, idx) => (
          <div key={idx} className="space-y-1.5">
            <h2 className="px-3 text-[11px] font-semibold uppercase tracking-wider text-infra-muted/80 font-mono">
              {section.title}
            </h2>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon as any;
                const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors group',
                      isActive
                        ? 'bg-infra-card border border-infra-border text-emerald-400 font-semibold shadow-sm'
                        : 'text-infra-text hover:text-infra-heading hover:bg-infra-cardHover/60'
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon
                        size={16}
                        className={cn(
                          'transition-colors',
                          isActive ? 'text-emerald-400' : 'text-infra-muted group-hover:text-infra-text'
                        )}
                      />
                      <span>{item.label}</span>
                    </div>

                    {item.highlight && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded-md bg-emerald-500/15 text-emerald-300 font-mono flex items-center gap-1">
                        <Sparkles size={10} /> 14-Step
                      </span>
                    )}

                    {item.badge && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded-md bg-rose-500/15 text-rose-300 font-mono">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom Environment & Tenant Bar */}
      <div className="p-4 border-t border-infra-border bg-infra-card/40 text-xs">
        <div className="flex items-center justify-between text-infra-muted text-[11px]">
          <div className="flex items-center gap-1.5 font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Staging / Prod Mode</span>
          </div>
          <span className="font-mono text-infra-text">acme-corp</span>
        </div>
      </div>
    </aside>
  );
}
