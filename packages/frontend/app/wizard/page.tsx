'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  Check,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  Database,
  Layers,
  Sparkles,
  GitCompare,
  Eye,
  Settings,
  Play,
  Activity,
  FileCheck,
  Download,
  AlertTriangle,
  RefreshCw,
  Hash,
  FileSpreadsheet,
  CheckCircle2,
} from 'lucide-react';
import { Badge } from '../../components/common/Badge';
import { PlanApprovalModal } from '../../components/wizard/PlanApprovalModal';
import { TransformPreviewDrawer } from '../../components/mappings/TransformPreviewDrawer';
import {
  MOCK_CONNECTIONS,
  MOCK_MONGO_SNAPSHOT,
  MOCK_POSTGRES_SNAPSHOT,
  MOCK_MAPPING_VERSIONS,
  MOCK_PLANS,
  MOCK_MIGRATION_RUNS,
  MOCK_VALIDATION_RUN,
} from '../../lib/mock-data';
import { MigrationPlan, MigrationRun } from '../../lib/types';
import { formatNumber, truncateHash } from '../../lib/utils';
import { apiClient } from '../../lib/api-client';

const WIZARD_STEPS = [
  { id: 1, name: 'Source Select', desc: 'Select MongoDB database' },
  { id: 2, name: 'Target Select', desc: 'Select PostgreSQL database' },
  { id: 3, name: 'Handshake', desc: 'Verify connectivity' },
  { id: 4, name: 'Source Schema', desc: 'Discover BSON structures' },
  { id: 5, name: 'Target Schema', desc: 'Inspect SQL constraints' },
  { id: 6, name: 'AI Mapping', desc: 'Synthesize recommendations' },
  { id: 7, name: 'Mapping Review', desc: 'Configure transformations' },
  { id: 8, name: 'Sample Preview', desc: 'Test in-memory conversion' },
  { id: 9, name: 'Plan Config', desc: 'Set batch size & workers' },
  { id: 10, name: 'Dry Run', desc: 'Execute isolated dry-run' },
  { id: 11, name: 'Hash Approval', desc: 'Cryptographic SHA-256 sign' },
  { id: 12, name: 'Live Execution', desc: 'Stream batches & checkpoints' },
  { id: 13, name: 'Validation', desc: 'Reconcile 45-defect benchmark' },
  { id: 14, name: 'Export Reports', desc: 'Download CSV / HTML audit' },
];

export default function MigrationWizardPage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [sourceConnId, setSourceConnId] = useState('conn-mongo-prod-01');
  const [targetConnId, setTargetConnId] = useState('conn-pg-prod-01');
  const [plan, setPlan] = useState<MigrationPlan>(MOCK_PLANS[0]);
  const [isApprovalOpen, setIsApprovalOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [dryRunRunning, setDryRunRunning] = useState(false);
  const [dryRunSuccess, setDryRunSuccess] = useState(false);

  const nextStep = () => setCurrentStep((prev) => Math.min(prev + 1, 14));
  const prevStep = () => setCurrentStep((prev) => Math.max(prev - 1, 1));

  const handleTriggerDryRun = () => {
    setDryRunRunning(true);
    setTimeout(() => {
      setDryRunRunning(false);
      setDryRunSuccess(true);
    }, 1500);
  };

  const handlePlanApproved = (approvedPlan: MigrationPlan) => {
    setPlan(approvedPlan);
    nextStep();
  };

  return (
    <div className="space-y-6">
      {/* Wizard Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-infra-heading tracking-tight flex items-center gap-2">
            <span>Guided 14-Step Migration Wizard</span>
            <span className="px-2 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
              Deterministic Assurance
            </span>
          </h1>
          <p className="text-xs text-infra-muted mt-1 font-mono">
            Follow end-to-end audited workflow from connection verification to cryptographic approval and validation
          </p>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-infra-muted">Current Stage:</span>
          <span className="text-emerald-400 font-bold">Step {currentStep} of 14</span>
        </div>
      </div>

      {/* Progress Step Indicator Bar */}
      <div className="p-4 rounded-xl bg-infra-card border border-infra-border overflow-x-auto">
        <div className="flex items-center justify-between min-w-[900px] gap-2">
          {WIZARD_STEPS.map((s) => {
            const isCompleted = s.id < currentStep;
            const isCurrent = s.id === currentStep;

            return (
              <button
                key={s.id}
                onClick={() => setCurrentStep(s.id)}
                className={`flex flex-col items-center gap-1 group focus:outline-none transition-all ${
                  isCurrent
                    ? 'text-emerald-400 font-bold'
                    : isCompleted
                    ? 'text-infra-text'
                    : 'text-infra-muted/60'
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-mono border transition-all ${
                    isCurrent
                      ? 'bg-emerald-500 text-infra-base border-emerald-400 font-bold ring-2 ring-emerald-500/30'
                      : isCompleted
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : 'bg-infra-surface border-infra-border text-infra-muted'
                  }`}
                >
                  {isCompleted ? <Check size={13} /> : s.id}
                </div>
                <span className="text-[10px] font-mono whitespace-nowrap">{s.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step Content Box */}
      <div className="p-6 rounded-xl bg-infra-card border border-infra-border min-h-[420px] flex flex-col justify-between">
        {/* Step 1: Source Select */}
        {currentStep === 1 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Database size={16} className="text-emerald-400" />
              <span>Step 1: Select Source MongoDB Database Profile</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Choose the source database connection profile containing documents to migrate.
            </p>

            <div className="grid grid-cols-2 gap-4 pt-2">
              {MOCK_CONNECTIONS.filter((c) => c.engine === 'MONGODB').map((c) => (
                <div
                  key={c.id}
                  onClick={() => setSourceConnId(c.id)}
                  className={`p-4 rounded-xl border cursor-pointer transition-all ${
                    sourceConnId === c.id
                      ? 'bg-emerald-500/10 border-emerald-500 text-emerald-300 ring-1 ring-emerald-500'
                      : 'bg-infra-surface border-infra-border text-infra-text hover:border-infra-borderHover'
                  }`}
                >
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-bold text-xs font-mono">{c.name}</span>
                    <Badge variant="emerald" size="sm">v{c.credentialVersion}</Badge>
                  </div>
                  <p className="text-xs font-mono text-infra-muted">
                    {c.config.host}:{c.config.port}/{c.config.database}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: Target Select */}
        {currentStep === 2 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Database size={16} className="text-sky-400" />
              <span>Step 2: Select Destination PostgreSQL Database Profile</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Choose the target relational database where typed records and relations will be written.
            </p>

            <div className="grid grid-cols-2 gap-4 pt-2">
              {MOCK_CONNECTIONS.filter((c) => c.engine === 'POSTGRESQL').map((c) => (
                <div
                  key={c.id}
                  onClick={() => setTargetConnId(c.id)}
                  className={`p-4 rounded-xl border cursor-pointer transition-all ${
                    targetConnId === c.id
                      ? 'bg-sky-500/10 border-sky-500 text-sky-300 ring-1 ring-sky-500'
                      : 'bg-infra-surface border-infra-border text-infra-text hover:border-infra-borderHover'
                  }`}
                >
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-bold text-xs font-mono">{c.name}</span>
                    <Badge variant="sky" size="sm">v{c.credentialVersion}</Badge>
                  </div>
                  <p className="text-xs font-mono text-infra-muted">
                    {c.config.host}:{c.config.port}/{c.config.database} (schema: {c.config.schema})
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: Handshake */}
        {currentStep === 3 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <ShieldCheck size={16} className="text-emerald-400" />
              <span>Step 3: Dual Connection Verification & Latency Handshake</span>
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-infra-surface border border-emerald-500/30 text-xs font-mono space-y-2">
                <span className="text-emerald-400 font-bold block">Source MongoDB Handshake</span>
                <p className="text-infra-text">Status: 200 OK • Read/Extract Authorized</p>
                <p className="text-infra-muted">Latency: 14ms • TLS 1.3 Cipher Suite Verified</p>
              </div>
              <div className="p-4 rounded-xl bg-infra-surface border border-sky-500/30 text-xs font-mono space-y-2">
                <span className="text-sky-400 font-bold block">Destination Postgres Handshake</span>
                <p className="text-infra-text">Status: 200 OK • Upsert/DDL Permissions Active</p>
                <p className="text-infra-muted">Latency: 8ms • TLS 1.3 Cipher Suite Verified</p>
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Source Schema */}
        {currentStep === 4 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Layers size={16} className="text-emerald-400" />
              <span>Step 4: Source MongoDB Schema Discovery (snap-mongo-001)</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Discovered 2 collections, 10,000 customers documents, and observed embedded BSON types.
            </p>
            <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono space-y-1">
              <div className="flex justify-between">
                <span>Collection: customers</span>
                <span className="text-emerald-400">10,000 documents (2.45 KB avg size)</span>
              </div>
              <div className="flex justify-between text-infra-muted">
                <span>Key fields: _id, name, email, createdAt, address, metadata, attachments, orders</span>
                <span>Zero nulls on PK/email</span>
              </div>
            </div>
          </div>
        )}

        {/* Step 5: Target Schema */}
        {currentStep === 5 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Layers size={16} className="text-sky-400" />
              <span>Step 5: Target PostgreSQL Schema Inspection (snap-pg-001)</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Target tables ready in <code>public</code> schema: customers, orders, customer_metadata, customer_attachments.
            </p>
            <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono">
              <span className="text-sky-400 font-bold block mb-1">Normalized Relational Target Model:</span>
              <p className="text-infra-muted">
                FK relationships configured between <code>orders.customer_id</code> and <code>customers.id</code>. Unique constraints set on <code>source_id</code> and <code>email</code>.
              </p>
            </div>
          </div>
        )}

        {/* Step 6: AI Mapping */}
        {currentStep === 6 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Sparkles size={16} className="text-emerald-400" />
              <span>Step 6: AI Mapping Recommendations & Rationale</span>
            </h3>
            <div className="p-4 rounded-xl bg-infra-surface border border-emerald-500/30 text-xs font-mono space-y-2">
              <p className="text-emerald-300 font-bold">Recommendations Synthesized (Confidence: 98%):</p>
              <ul className="list-disc pl-5 space-y-1 text-infra-text font-sans">
                <li>Map <code>customers.createdAt</code> to <code>created_at</code> using <code>PARSE_TIMESTAMP</code>.</li>
                <li>Convert <code>customers.email</code> using <code>LOWERCASE</code> to satisfy unique constraint.</li>
                <li>Serialize complex <code>customers.address</code> object using <code>TO_JSONB</code>.</li>
                <li>Normalize array <code>customers.orders[]</code> into relational child table <code>public.orders</code>.</li>
              </ul>
            </div>
          </div>
        )}

        {/* Step 7: Mapping Review */}
        {currentStep === 7 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <GitCompare size={16} className="text-indigo-400" />
              <span>Step 7: Visual Mapping Review & Allowlist Rules</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Deterministic mapping DSL profile <code>map-ver-001</code> contains 8 verified transform rules.
            </p>
            <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono">
              <span className="text-emerald-400 font-semibold">DSL Validation: PASS (0 blocking issues)</span>
            </div>
          </div>
        )}

        {/* Step 8: Sample Preview */}
        {currentStep === 8 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Eye size={16} className="text-emerald-400" />
              <span>Step 8: Sample Transform Preview on In-Memory Documents</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Execute pure deterministic transformation functions on bounded in-memory fixture.
            </p>
            <button
              onClick={() => setIsPreviewOpen(true)}
              className="px-4 py-2 rounded-lg text-xs font-mono font-semibold bg-infra-surface border border-emerald-500/40 text-emerald-300 hover:bg-infra-cardHover"
            >
              Open Interactive JSON Preview Drawer
            </button>
          </div>
        )}

        {/* Step 9: Plan Config */}
        {currentStep === 9 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Settings size={16} className="text-emerald-400" />
              <span>Step 9: Migration Plan & Worker Concurrency Settings</span>
            </h3>
            <div className="grid grid-cols-3 gap-4 pt-2">
              <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono">
                <span className="text-infra-muted block text-[10px] uppercase">Batch Size</span>
                <span className="text-infra-heading font-bold text-sm">500 docs/batch</span>
              </div>
              <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono">
                <span className="text-infra-muted block text-[10px] uppercase">Concurrency</span>
                <span className="text-infra-heading font-bold text-sm">4 parallel workers</span>
              </div>
              <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono">
                <span className="text-infra-muted block text-[10px] uppercase">Write Mode</span>
                <span className="text-sky-400 font-bold text-sm">UPSERT_ON_KEY</span>
              </div>
            </div>
          </div>
        )}

        {/* Step 10: Dry Run */}
        {currentStep === 10 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Play size={16} className="text-emerald-400" />
              <span>Step 10: Deterministic Readiness & Dry-Run Execution</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Run dry-run against bounded sample data to verify constraint adherence without committing data.
            </p>

            <div className="p-4 rounded-xl bg-infra-surface border border-infra-border space-y-3">
              <button
                onClick={handleTriggerDryRun}
                disabled={dryRunRunning || dryRunSuccess}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-infra-base transition-colors"
              >
                {dryRunRunning ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
                <span>{dryRunRunning ? 'Executing Dry Run...' : dryRunSuccess ? 'Dry Run Passed (100%)' : 'Trigger Dry Run'}</span>
              </button>

              {dryRunSuccess && (
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs font-mono text-emerald-300">
                  Dry run finished: 500 sample documents evaluated. Zero constraint violations. Plan hash ready for cryptographic signing.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 11: Hash Approval */}
        {currentStep === 11 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <ShieldCheck size={16} className="text-emerald-400" />
              <span>Step 11: Cryptographic Plan Hash Review & Approval</span>
            </h3>
            <div className="p-4 rounded-xl bg-infra-surface border border-emerald-500/30 space-y-3 font-mono text-xs">
              <div className="flex justify-between items-center">
                <span className="text-infra-muted">Plan Status:</span>
                <Badge variant={plan.status === 'APPROVED' ? 'emerald' : 'amber'}>
                  {plan.status}
                </Badge>
              </div>
              <div>
                <span className="text-infra-muted block mb-1">Canonical SHA-256 Hash:</span>
                <div className="p-2.5 rounded bg-black/60 border border-infra-border text-emerald-300 break-all select-all">
                  {plan.planHash}
                </div>
              </div>

              {plan.status === 'APPROVED' ? (
                <div className="p-2.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-400" />
                  <span>Approved by {plan.approvedBy} at {plan.approvedAt}</span>
                </div>
              ) : (
                <button
                  onClick={() => setIsApprovalOpen(true)}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors"
                >
                  Review & Sign Plan Approval
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step 12: Live Execution */}
        {currentStep === 12 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Activity size={16} className="text-emerald-400" />
              <span>Step 12: Migration Execution & Streaming Monitor</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Real-time progress: 8,500 / 10,000 records processed across 17 batches.
            </p>
            <div className="p-4 rounded-xl bg-infra-surface border border-infra-border space-y-2 font-mono text-xs">
              <div className="flex justify-between">
                <span>Throughput: 425 records/sec</span>
                <span className="text-emerald-400">85% Complete</span>
              </div>
              <div className="w-full h-2 rounded-full bg-black/60 overflow-hidden">
                <div className="h-full bg-emerald-400 w-[85%]" />
              </div>
            </div>
          </div>
        )}

        {/* Step 13: Validation */}
        {currentStep === 13 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-400" />
              <span>Step 13: Deterministic Validation & Discrepancy Reconciliation</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Validation run completed: identified exactly 45 seeded discrepancies matching Section 10 benchmark!
            </p>
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs font-mono space-y-2 text-amber-300">
              <p className="font-bold">45 Seeded Discrepancies Reconciled:</p>
              <div className="grid grid-cols-4 gap-2 text-center text-[11px]">
                <div className="p-2 rounded bg-black/40 border border-amber-500/20">
                  <span className="block text-amber-400 font-bold text-sm">15</span>
                  <span>Missing Attachments</span>
                </div>
                <div className="p-2 rounded bg-black/40 border border-amber-500/20">
                  <span className="block text-amber-400 font-bold text-sm">10</span>
                  <span>Duplicate Records</span>
                </div>
                <div className="p-2 rounded bg-black/40 border border-amber-500/20">
                  <span className="block text-amber-400 font-bold text-sm">8</span>
                  <span>Broken References</span>
                </div>
                <div className="p-2 rounded bg-black/40 border border-amber-500/20">
                  <span className="block text-amber-400 font-bold text-sm">12</span>
                  <span>Metadata Mismatches</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 14: Export Reports */}
        {currentStep === 14 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <FileSpreadsheet size={16} className="text-emerald-400" />
              <span>Step 14: Assurance Report Export & Immutable Audit Timeline</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Download certified audit reports and CSV evidence logs for corporate compliance.
            </p>

            <div className="flex gap-3 pt-2">
              <Link
                href="/reports"
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors shadow-md shadow-emerald-500/20"
              >
                <Download size={14} />
                <span>Download Executive HTML Report</span>
              </Link>
              <Link
                href="/reports"
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-mono font-semibold bg-infra-surface border border-infra-border hover:bg-infra-cardHover text-infra-text transition-colors"
              >
                <Download size={14} />
                <span>Export 45 Discrepancies CSV</span>
              </Link>
            </div>
          </div>
        )}

        {/* Wizard Bottom Navigation Buttons */}
        <div className="flex items-center justify-between pt-6 border-t border-infra-border mt-6">
          <button
            onClick={prevStep}
            disabled={currentStep === 1}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-mono font-medium text-infra-muted hover:text-infra-heading disabled:opacity-30 transition-colors"
          >
            <ArrowLeft size={14} />
            <span>Previous Step</span>
          </button>

          <button
            onClick={nextStep}
            disabled={currentStep === 14}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-30 text-infra-base transition-colors shadow-lg shadow-emerald-500/20"
          >
            <span>{currentStep === 14 ? 'Completed' : 'Next Step'}</span>
            <ArrowRight size={14} />
          </button>
        </div>
      </div>

      {/* Plan Approval Modal */}
      <PlanApprovalModal
        isOpen={isApprovalOpen}
        onClose={() => setIsApprovalOpen(false)}
        plan={plan}
        onApproved={handlePlanApproved}
      />

      {/* Sample Transform Preview Drawer */}
      <TransformPreviewDrawer
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        previewData={{
          source: {
            _id: '507f1f77bcf86cd799439011',
            name: '  Acme Enterprise LLC  ',
            email: 'CONTACT@ACME.COM',
            createdAt: '2026-11-19T20:00:00.000Z',
            address: { city: 'San Francisco', state: 'CA' },
          },
          transformed: {
            source_id: '507f1f77bcf86cd799439011',
            name: 'Acme Enterprise LLC',
            email: 'contact@acme.com',
            created_at: '2026-11-19T20:00:00.000Z',
            address: '{"city":"San Francisco","state":"CA"}',
          },
          transformStepsApplied: [
            { field: 'name', op: 'TRIM_STRING', before: '  Acme Enterprise LLC  ', after: 'Acme Enterprise LLC' },
            { field: 'email', op: 'LOWERCASE', before: 'CONTACT@ACME.COM', after: 'contact@acme.com' },
            { field: 'address', op: 'TO_JSONB', before: '[Object]', after: 'JSON stringified' },
          ],
        }}
      />
    </div>
  );
}
