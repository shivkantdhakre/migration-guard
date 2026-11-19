'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, Activity } from 'lucide-react';
import MigrationExecutionPage from '../page';

export default function MigrationDetailPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs font-mono text-infra-muted">
        <Link href="/migrations" className="hover:text-emerald-400 flex items-center gap-1">
          <ArrowLeft size={12} />
          <span>Back to Migrations</span>
        </Link>
        <span>/</span>
        <span className="text-infra-heading">{params.id}</span>
      </div>

      <MigrationExecutionPage />
    </div>
  );
}
