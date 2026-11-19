import React from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '4xl';
}

export function Modal({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  maxWidth = 'lg',
}: ModalProps) {
  if (!isOpen) return null;

  const maxWidthStyles = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '4xl': 'max-w-4xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/75 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Modal Container */}
      <div
        className={cn(
          'relative w-full rounded-xl bg-infra-card border border-infra-border shadow-2xl p-6 z-10 text-infra-text overflow-hidden max-h-[90vh] flex flex-col',
          maxWidthStyles[maxWidth]
        )}
      >
        <div className="flex items-start justify-between pb-4 border-b border-infra-border">
          <div>
            <h3 className="text-lg font-semibold text-infra-heading tracking-tight">{title}</h3>
            {subtitle && <p className="text-xs text-infra-muted mt-0.5">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="text-infra-muted hover:text-infra-heading p-1.5 rounded-lg hover:bg-infra-cardHover transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto py-4 flex-1">{children}</div>
      </div>
    </div>
  );
}
