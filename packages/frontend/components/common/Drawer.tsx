import React from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  width?: 'md' | 'lg' | 'xl' | '2xl';
}

export function Drawer({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  width = 'lg',
}: DrawerProps) {
  if (!isOpen) return null;

  const widthStyles = {
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-2xl',
    '2xl': 'max-w-4xl',
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      <div className="fixed inset-y-0 right-0 flex pl-10 max-w-full">
        <div
          className={cn(
            'w-screen bg-infra-surface border-l border-infra-border shadow-2xl flex flex-col',
            widthStyles[width]
          )}
        >
          {/* Header */}
          <div className="p-5 border-b border-infra-border flex items-center justify-between bg-infra-card/60">
            <div>
              <h2 className="text-base font-semibold text-infra-heading tracking-tight">{title}</h2>
              {subtitle && <p className="text-xs text-infra-muted mt-0.5">{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              aria-label="Close drawer"
              className="text-infra-muted hover:text-infra-heading p-1.5 rounded-lg hover:bg-infra-cardHover transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
