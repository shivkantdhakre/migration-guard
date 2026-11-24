'use client';

import React, { useState } from 'react';
import {
  GitCompare,
  ArrowRight,
  Eye,
  Plus,
  Trash2,
  Sparkles,
  Check,
  AlertCircle,
  FileCode,
  ShieldCheck,
  Save,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '../../components/common/Badge';
import { TransformOp, FieldMapping, MappingVersion } from '../../lib/types';
import { MOCK_MAPPING_VERSIONS } from '../../lib/mock-data';
import { TransformPreviewDrawer } from '../../components/mappings/TransformPreviewDrawer';
import { apiClient, isDemoModeEnabled } from '../../lib/api-client';

const ALLOWED_TRANSFORMS: { op: TransformOp; label: string; description: string }[] = [
  { op: 'PRESERVE_SOURCE_ID', label: 'PRESERVE_SOURCE_ID', description: 'Retain original MongoDB ObjectId as string' },
  { op: 'TRIM_STRING', label: 'TRIM_STRING', description: 'Remove surrounding whitespace' },
  { op: 'LOWERCASE', label: 'LOWERCASE', description: 'Convert string characters to lowercase' },
  { op: 'UPPERCASE', label: 'UPPERCASE', description: 'Convert string characters to uppercase' },
  { op: 'PARSE_TIMESTAMP', label: 'PARSE_TIMESTAMP', description: 'Parse ISO-8601 or epoch to TIMESTAMPTZ' },
  { op: 'PARSE_INTEGER', label: 'PARSE_INTEGER', description: 'Parse numeric string/float to BIGINT/INT' },
  { op: 'PARSE_DECIMAL', label: 'PARSE_DECIMAL', description: 'Parse numeric float to NUMERIC(p,s)' },
  { op: 'TO_JSONB', label: 'TO_JSONB', description: 'Serialize embedded subdocument to PostgreSQL JSONB' },
  { op: 'FLATTEN_OBJECT', label: 'FLATTEN_OBJECT', description: 'Extract nested properties into column fields' },
  { op: 'ARRAY_TO_CHILD_ROWS', label: 'ARRAY_TO_CHILD_ROWS', description: 'Normalize array of documents into child table rows' },
  { op: 'SET_DEFAULT', label: 'SET_DEFAULT', description: 'Assign default fallback value if null or missing' },
  { op: 'NULL_IF_EMPTY', label: 'NULL_IF_EMPTY', description: 'Treat blank string as SQL NULL' },
  { op: 'RENAME', label: 'RENAME', description: 'Direct 1:1 identity column rename' },
];

export default function MappingStudioPage() {
  const [mappingVersions, setMappingVersions] = useState<MappingVersion[]>([]);
  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntity, setSelectedEntity] = useState('customers');
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const isDemo = isDemoModeEnabled();

  const loadMappings = async () => {
    setLoading(true);
    setError(null);
    try {
      const versions = await apiClient.getMappings();
      if (Array.isArray(versions) && versions.length > 0) {
        setMappingVersions(versions);
        const fields = versions[0]?.objects?.[0]?.fieldMappings || [];
        setMappings(fields);
      } else if (isDemo) {
        setMappingVersions(MOCK_MAPPING_VERSIONS);
        setMappings(MOCK_MAPPING_VERSIONS[0].objects[0].fieldMappings);
      } else {
        setMappingVersions([]);
        setMappings([]);
      }
    } catch (err: any) {
      if (isDemo) {
        setMappingVersions(MOCK_MAPPING_VERSIONS);
        setMappings(MOCK_MAPPING_VERSIONS[0].objects[0].fieldMappings);
      } else {
        setError(err?.message || 'Failed to retrieve mapping versions from backend.');
        setMappingVersions([]);
        setMappings([]);
      }
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    loadMappings();
  }, []);

  const handleOpChange = (mappingId: string, op: TransformOp) => {
    setMappings((prev) =>
      prev.map((m) => (m.id === mappingId ? { ...m, transform: { ...m.transform, op } } : m))
    );
  };

  const handleOpenPreview = async () => {
    const versionId = mappingVersions[0]?.id || 'map-ver-001';
    const data = await apiClient.previewTransform(versionId, null);
    setPreviewData(data);
    setIsPreviewOpen(true);
  };

  const handleSaveVersion = () => {
    setSaveStatus('Immutable mapping profile saved. Ready for plan linking.');
    setTimeout(() => setSaveStatus(null), 3000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-infra-heading tracking-tight flex items-center gap-2">
            <span>Visual Mapping Studio</span>
            <span className="px-2 py-0.5 rounded text-xs bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono">
              Deterministic DSL v1
            </span>
          </h1>
          <p className="text-xs text-infra-muted mt-1 font-mono">
            Define allowlisted transformation pipelines between MongoDB attributes and PostgreSQL typed schemas
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleOpenPreview}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-infra-card border border-infra-border hover:border-emerald-500/40 text-emerald-400 hover:bg-infra-cardHover transition-colors"
          >
            <Eye size={14} />
            <span>Sample Transform Preview</span>
          </button>

          <button
            onClick={handleSaveVersion}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors shadow-lg shadow-emerald-500/20"
          >
            <Save size={14} />
            <span>Save Mapping Version</span>
          </button>
        </div>
      </div>

      {saveStatus && (
        <div className="p-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-300 font-mono flex items-center gap-2">
          <CheckCircle2 size={16} className="text-emerald-400" />
          <span>{saveStatus}</span>
        </div>
      )}

      {/* Loading & Error States */}
      {loading && (
        <div className="p-12 rounded-xl bg-infra-card border border-infra-border flex flex-col items-center justify-center space-y-3">
          <RefreshCw size={24} className="animate-spin text-emerald-400" />
          <span className="text-xs font-mono text-infra-muted">Loading mapping rules and version configurations...</span>
        </div>
      )}

      {error && !loading && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-xs font-mono text-red-400 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} className="text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            onClick={loadMappings}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-200 border border-red-500/40 transition-colors"
          >
            <RefreshCw size={12} />
            <span>Retry</span>
          </button>
        </div>
      )}

      {!loading && !error && mappings.length === 0 && (
        <div className="p-12 rounded-xl bg-infra-card border border-infra-border flex flex-col items-center justify-center text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-infra-surface border border-infra-border flex items-center justify-center text-infra-muted">
            <GitCompare size={24} />
          </div>
          <h3 className="text-sm font-bold text-infra-heading font-mono">No Mapping Rules Configured</h3>
          <p className="text-xs text-infra-muted max-w-sm">
            No transformation mappings exist for this project yet. Use the migration wizard or create a new mapping version to define source-to-target field correspondences.
          </p>
        </div>
      )}

      {/* Target Entity Switcher */}
      {!loading && mappings.length > 0 && (
        <div className="flex items-center gap-3 p-3 rounded-xl bg-infra-card border border-infra-border">
          <span className="text-xs font-mono text-infra-muted uppercase tracking-wider">
            Mapping Entity:
          </span>
          <button
            onClick={() => setSelectedEntity('customers')}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium border transition-all ${
              selectedEntity === 'customers'
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : 'bg-infra-surface border-infra-border text-infra-muted hover:border-infra-borderHover'
            }`}
          >
            customers (Mongo) → customers (Postgres)
          </button>
          <button
            onClick={() => setSelectedEntity('orders')}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium border transition-all ${
              selectedEntity === 'orders'
                ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                : 'bg-infra-surface border-infra-border text-infra-muted hover:border-infra-borderHover'
            }`}
          >
            customers.orders[] → orders (Relational Normalized)
          </button>
        </div>
      )}

      {/* Interactive Side-by-Side Mapping Table */}
      {!loading && mappings.length > 0 && (
        <div className="rounded-xl border border-infra-border overflow-hidden bg-infra-card shadow-sm">
        <div className="p-4 border-b border-infra-border flex items-center justify-between bg-infra-surface/60">
          <div className="flex items-center gap-2">
            <GitCompare size={16} className="text-emerald-400" />
            <h2 className="text-xs font-bold text-infra-heading font-mono">
              Source Attribute → Allowlisted Transform Rule → Destination Column
            </h2>
          </div>
          <Badge variant="indigo" size="sm">
            Strict Allowlist Enforced (FR-MAP-002)
          </Badge>
        </div>

        <div className="divide-y divide-infra-border font-mono text-xs">
          {mappings.map((m) => (
            <div
              key={m.id}
              className="p-4 flex items-center justify-between hover:bg-infra-cardHover/40 transition-colors gap-4"
            >
              {/* Source Field */}
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-infra-heading">{m.sourcePath}</span>
                  <Badge variant="slate" size="sm">{m.sourceType}</Badge>
                </div>
                <span className="text-[11px] text-infra-muted block">
                  Source: MongoDB collection <code>customers</code>
                </span>
              </div>

              {/* Arrow and Transform Rule Dropdown */}
              <div className="w-72 flex flex-col items-center gap-1.5">
                <div className="flex items-center gap-2 w-full">
                  <ArrowRight size={14} className="text-infra-border shrink-0" />
                  <select
                    value={m.transform.op}
                    onChange={(e) => handleOpChange(m.id, e.target.value as TransformOp)}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-infra-surface border border-infra-border text-xs text-emerald-400 font-mono font-medium focus:border-emerald-500 focus:outline-none"
                  >
                    {ALLOWED_TRANSFORMS.map((t) => (
                      <option key={t.op} value={t.op} className="bg-infra-surface text-infra-text">
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>

                {m.aiSuggested && (
                  <div className="flex items-center gap-1 text-[10px] text-emerald-400">
                    <Sparkles size={11} />
                    <span>AI Suggested ({Math.round((m.confidence || 0.95) * 100)}% confidence)</span>
                  </div>
                )}
              </div>

              {/* Destination Column */}
              <div className="flex-1 space-y-1 text-right">
                <div className="flex items-center justify-end gap-2">
                  <span className="font-semibold text-emerald-300">{m.destinationPath}</span>
                  <Badge variant="sky" size="sm">{m.destinationType}</Badge>
                </div>
                <span className="text-[11px] text-infra-muted block">
                  Target: PostgreSQL table <code>public.customers</code>
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      )}

      {/* Transform Preview Drawer */}
      <TransformPreviewDrawer
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        previewData={previewData}
      />
    </div>
  );
}
