'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import ValidationCenterPage from '../page';

export default function ValidationDetailPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs font-mono text-infra-muted">
        <Link href="/validation" className="hover:text-emerald-400 flex items-center gap-1">
          <ArrowLeft size={12} />
          <span>Back to Validation Center</span>
        </Link>
        <span>/</span>
        <span className="text-infra-heading">{params.id}</span>
      </div>

      <ValidationCenterPage />
    </div>
  );
}
