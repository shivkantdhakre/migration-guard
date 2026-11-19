import React from 'react';
import { cn } from '../../lib/utils';

export interface BadgeProps {
  children: React.ReactNode;
  variant?: 'emerald' | 'amber' | 'rose' | 'sky' | 'indigo' | 'slate' | 'purple';
  size?: 'sm' | 'md';
  className?: string;
  dot?: boolean;
}

export function Badge({
  children,
  variant = 'slate',
  size = 'md',
  className,
  dot = false,
}: BadgeProps) {
  const variantStyles = {
    emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    rose: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    sky: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    indigo: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
    slate: 'bg-slate-800/80 text-slate-300 border-slate-700/60',
    purple: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  };

  const dotStyles = {
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
    rose: 'bg-rose-400',
    sky: 'bg-sky-400',
    indigo: 'bg-indigo-400',
    slate: 'bg-slate-400',
    purple: 'bg-purple-400',
  };

  const sizeStyles = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-xs px-2.5 py-1',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-medium rounded-full border tracking-wide font-mono',
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full animate-pulse', dotStyles[variant])} />}
      {children}
    </span>
  );
}
