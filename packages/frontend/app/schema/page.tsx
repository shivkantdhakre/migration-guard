'use client';

import React, { useEffect, useState } from 'react';
import {
  Layers,
  Database,
  GitCompare,
  Search,
  Table,
  Columns,
  Hash,
  ChevronRight,
  ChevronDown,
  Key,
  Link as LinkIcon,
  Sparkles,
  RefreshCw,
  FileCode,
  AlertTriangle,
} from 'lucide-react';
import { Badge } from '../../components/common/Badge';
import { SchemaSnapshot } from '../../lib/types';
import { MOCK_MONGO_SNAPSHOT, MOCK_POSTGRES_SNAPSHOT } from '../../lib/mock-data';
import { apiClient, isDemoModeEnabled } from '../../lib/api-client';
import { SnapshotDiffModal } from '../../components/schema/SnapshotDiffModal';
import { formatNumber, formatBytes } from '../../lib/utils';

export default function SchemaInspectorPage() {
  const [selectedMongoCol, setSelectedMongoCol] = useState('customers');
  const [selectedPgTable, setSelectedPgTable] = useState('customers');
  const [isDiffModalOpen, setIsDiffModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [mongoSnapshot, setMongoSnapshot] = useState<SchemaSnapshot | null>(null);
  const [pgSnapshot, setPgSnapshot] = useState<SchemaSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isDemo = isDemoModeEnabled();

  const loadSchemas = async () => {
    setLoading(true);
    setError(null);
    try {
      const connections = await apiClient.getConnections();
      const mongoConn = connections.find((c) => c.engine === 'MONGODB');
      const pgConn = connections.find((c) => c.engine === 'POSTGRESQL');

      let foundMongo: SchemaSnapshot | null = null;
      let foundPg: SchemaSnapshot | null = null;

      if (mongoConn) {
        const snaps = await apiClient.getSchemaSnapshots(mongoConn.id);
        if (snaps && snaps.length > 0) foundMongo = snaps[0];
      }
      if (pgConn) {
        const snaps = await apiClient.getSchemaSnapshots(pgConn.id);
        if (snaps && snaps.length > 0) foundPg = snaps[0];
      }

      if (foundMongo) {
        setMongoSnapshot(foundMongo);
        if (foundMongo.collections && foundMongo.collections.length > 0) {
          setSelectedMongoCol(foundMongo.collections[0].name);
        }
      } else if (isDemo) {
        setMongoSnapshot(MOCK_MONGO_SNAPSHOT);
      }

      if (foundPg) {
        setPgSnapshot(foundPg);
        if (foundPg.tables && foundPg.tables.length > 0) {
          setSelectedPgTable(foundPg.tables[0].name);
        }
      } else if (isDemo) {
        setPgSnapshot(MOCK_POSTGRES_SNAPSHOT);
      }
    } catch (err: any) {
      if (isDemo) {
        setMongoSnapshot(MOCK_MONGO_SNAPSHOT);
        setPgSnapshot(MOCK_POSTGRES_SNAPSHOT);
      } else {
        setError(err?.message || 'Failed to retrieve schema snapshots from backend.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSchemas();
  }, []);

  const activeMongo = mongoSnapshot || (isDemo ? MOCK_MONGO_SNAPSHOT : null);
  const activePg = pgSnapshot || (isDemo ? MOCK_POSTGRES_SNAPSHOT : null);

  const currentMongoCollection =
    activeMongo?.collections?.find((c) => c.name === selectedMongoCol) ||
    activeMongo?.collections?.[0];

  const currentPgTable =
    activePg?.tables?.find((t) => t.name === selectedPgTable) ||
    activePg?.tables?.[0];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-infra-heading tracking-tight flex items-center gap-2">
            <span>Schema Discovery & Inspector</span>
            <span className="px-2 py-0.5 rounded text-xs bg-sky-500/10 text-sky-400 border border-sky-500/20 font-mono">
              Immutable Snapshots
            </span>
          </h1>
          <p className="text-xs text-infra-muted mt-1 font-mono">
            Interactive side-by-side inspection of discovered MongoDB documents vs relational PostgreSQL schemas
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsDiffModalOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-infra-card border border-infra-border hover:border-emerald-500/40 text-emerald-400 hover:bg-infra-cardHover transition-colors"
          >
            <GitCompare size={14} />
            <span>Compare Snapshot Diff</span>
          </button>
        </div>
      </div>

      {/* Loading & Error States */}
      {loading && (
        <div className="p-12 rounded-xl bg-infra-card border border-infra-border flex flex-col items-center justify-center space-y-3">
          <RefreshCw size={24} className="animate-spin text-emerald-400" />
          <span className="text-xs font-mono text-infra-muted">Inspecting schema snapshots and live metadata...</span>
        </div>
      )}

      {error && !loading && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-xs font-mono text-red-400 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            onClick={loadSchemas}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-200 border border-red-500/40 transition-colors"
          >
            <RefreshCw size={12} />
            <span>Retry</span>
          </button>
        </div>
      )}

      {!loading && !error && !activeMongo && !activePg && (
        <div className="p-12 rounded-xl bg-infra-card border border-infra-border flex flex-col items-center justify-center text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-infra-surface border border-infra-border flex items-center justify-center text-infra-muted">
            <Layers size={24} />
          </div>
          <h3 className="text-sm font-bold text-infra-heading font-mono">No Schema Snapshots Found</h3>
          <p className="text-xs text-infra-muted max-w-sm">
            No immutable schema discovery snapshots exist yet. Run schema discovery on your source or destination connection to inspect table structures.
          </p>
        </div>
      )}

      {/* Side-by-Side Dual Schema Browser */}
      {!loading && (activeMongo || activePg) && (
        <div className="grid grid-cols-2 gap-6">
          {/* Left: Source MongoDB Collection Tree */}
          <div className="p-5 rounded-xl bg-infra-card border border-infra-border space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-infra-border">
              <div className="flex items-center gap-2">
                <Database size={16} className="text-emerald-400" />
                <h2 className="text-xs font-bold text-infra-heading font-mono uppercase tracking-wider">
                  Source: MongoDB (appdb)
                </h2>
              </div>
              <Badge variant="emerald" size="sm">
                Snapshot: {activeMongo?.id || 'N/A'}
              </Badge>
            </div>

            {/* Collection Select Tabs */}
            {activeMongo?.collections && activeMongo.collections.length > 0 ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {activeMongo.collections.map((col) => (
                    <button
                      key={col.name}
                      onClick={() => setSelectedMongoCol(col.name)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-mono font-medium border transition-all ${
                        selectedMongoCol === col.name
                          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 shadow-sm'
                          : 'bg-infra-surface border-infra-border text-infra-muted hover:border-infra-borderHover'
                      }`}
                    >
                      <Layers size={13} />
                      <span>{col.name}</span>
                      <span className="text-[10px] opacity-75">({formatNumber(col.documentCount)})</span>
                    </button>
                  ))}
                </div>

                {currentMongoCollection && (
                  <>
                    {/* Collection Profiler Statistics */}
                    <div className="p-3 rounded-lg bg-infra-surface border border-infra-border grid grid-cols-3 gap-2 text-center text-xs font-mono">
                      <div>
                        <span className="text-infra-muted text-[10px] block uppercase">Documents</span>
                        <span className="text-infra-heading font-semibold">
                          {formatNumber(currentMongoCollection.documentCount)}
                        </span>
                      </div>
                      <div>
                        <span className="text-infra-muted text-[10px] block uppercase">Avg Doc Size</span>
                        <span className="text-infra-heading font-semibold">
                          {formatBytes(currentMongoCollection.avgDocSizeBytes)}
                        </span>
                      </div>
                      <div>
                        <span className="text-infra-muted text-[10px] block uppercase">Fields Detected</span>
                        <span className="text-emerald-400 font-semibold">
                          {currentMongoCollection.fields.length} Paths
                        </span>
                      </div>
                    </div>

                    {/* Fields List */}
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-mono text-infra-muted font-semibold uppercase tracking-wider">
                        Discovered Field Paths & Observed Types
                      </span>

                      <div className="rounded-lg border border-infra-border divide-y divide-infra-border overflow-hidden">
                        {currentMongoCollection.fields.map((field) => (
                          <div
                            key={field.name}
                            className="p-2.5 bg-infra-card/60 hover:bg-infra-cardHover/60 flex items-center justify-between text-xs font-mono transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              {field.isPrimaryKey && <Key size={12} className="text-amber-400" />}
                              <span className="text-infra-heading font-semibold">{field.name}</span>
                              <Badge variant="slate" size="sm">{field.type}</Badge>
                            </div>

                            <div className="flex items-center gap-2 text-[11px] text-infra-muted">
                              {field.nullPercentage !== undefined && (
                                <span>Nulls: {field.nullPercentage}%</span>
                              )}
                              {field.unique && <Badge variant="sky" size="sm">UNIQUE</Badge>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="text-xs font-mono text-infra-muted py-8 text-center">No MongoDB collections found in snapshot.</p>
            )}
          </div>

          {/* Right: Destination PostgreSQL Table Tree */}
          <div className="p-5 rounded-xl bg-infra-card border border-infra-border space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-infra-border">
              <div className="flex items-center gap-2">
                <Database size={16} className="text-sky-400" />
                <h2 className="text-xs font-bold text-infra-heading font-mono uppercase tracking-wider">
                  Destination: PostgreSQL (public)
                </h2>
              </div>
              <Badge variant="sky" size="sm">
                Snapshot: {activePg?.id || 'N/A'}
              </Badge>
            </div>

            {/* Table Select Tabs */}
            {activePg?.tables && activePg.tables.length > 0 ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {activePg.tables.map((table) => (
                    <button
                      key={table.name}
                      onClick={() => setSelectedPgTable(table.name)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium border transition-all ${
                        selectedPgTable === table.name
                          ? 'bg-sky-500/15 border-sky-500/40 text-sky-300 shadow-sm'
                          : 'bg-infra-surface border-infra-border text-infra-muted hover:border-infra-borderHover'
                      }`}
                    >
                      <Table size={13} />
                      <span>{table.name}</span>
                      <span className="text-[10px] opacity-75">({formatNumber(table.rowCount)})</span>
                    </button>
                  ))}
                </div>

                {currentPgTable && (
                  <>
                    {/* Table Statistics */}
                    <div className="p-3 rounded-lg bg-infra-surface border border-infra-border grid grid-cols-2 gap-2 text-center text-xs font-mono">
                      <div>
                        <span className="text-infra-muted text-[10px] block uppercase">Row Count</span>
                        <span className="text-infra-heading font-semibold">
                          {formatNumber(currentPgTable.rowCount)}
                        </span>
                      </div>
                      <div>
                        <span className="text-infra-muted text-[10px] block uppercase">Relational Columns</span>
                        <span className="text-sky-400 font-semibold">
                          {currentPgTable.columns.length} Columns
                        </span>
                      </div>
                    </div>

                    {/* Columns List */}
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-mono text-infra-muted font-semibold uppercase tracking-wider">
                        Columns, Data Types, and Foreign Keys
                      </span>

                      <div className="rounded-lg border border-infra-border divide-y divide-infra-border overflow-hidden">
                        {currentPgTable.columns.map((col) => (
                          <div
                            key={col.name}
                            className="p-2.5 bg-infra-card/60 hover:bg-infra-cardHover/60 flex items-center justify-between text-xs font-mono transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              {col.isPrimaryKey ? (
                                <Key size={12} className="text-amber-400" />
                              ) : col.isForeignKey ? (
                                <LinkIcon size={12} className="text-sky-400" />
                              ) : null}
                              <span className="text-infra-heading font-semibold">{col.name}</span>
                              <Badge variant="sky" size="sm">{col.type}</Badge>
                            </div>

                            <div className="flex items-center gap-2 text-[11px]">
                              {col.foreignKeyTarget && (
                                <span className="text-sky-300 text-[10px]">→ {col.foreignKeyTarget}</span>
                              )}
                              <span className="text-infra-muted">
                                {col.nullable ? 'NULL' : 'NOT NULL'}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="text-xs font-mono text-infra-muted py-8 text-center">No PostgreSQL tables found in snapshot.</p>
            )}
          </div>
        </div>
      )}

      {/* Snapshot Diff Modal */}
      <SnapshotDiffModal
        isOpen={isDiffModalOpen}
        onClose={() => setIsDiffModalOpen(false)}
        sourceSnapshotName="MongoDB appdb (snap-mongo-001)"
        targetSnapshotName="PostgreSQL public (snap-pg-001)"
      />
    </div>
  );
}
