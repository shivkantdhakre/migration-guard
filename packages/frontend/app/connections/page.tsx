'use client';

import React, { useEffect, useState } from 'react';
import {
  Database,
  Plus,
  RefreshCw,
  KeyRound,
  ShieldCheck,
  Check,
  AlertTriangle,
  Server,
  Lock,
  ExternalLink,
  Trash2,
  Activity,
  Layers,
} from 'lucide-react';
import { Badge } from '../../components/common/Badge';
import { DatabaseConnection } from '../../lib/types';
import { apiClient, isDemoModeEnabled } from '../../lib/api-client';
import { MOCK_CONNECTIONS } from '../../lib/mock-data';
import { CredentialRotationModal } from '../../components/connections/CredentialRotationModal';
import { ConnectionModal } from '../../components/connections/ConnectionModal';
import { formatDate } from '../../lib/utils';

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedConnectionForRotation, setSelectedConnectionForRotation] = useState<DatabaseConnection | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; latencyMs: number; message: string }>>({});
  const isDemo = isDemoModeEnabled();

  const loadConnections = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.getConnections();
      if (Array.isArray(data) && data.length > 0) {
        setConnections(data);
      } else if (isDemo) {
        setConnections(MOCK_CONNECTIONS);
      } else {
        setConnections([]);
      }
    } catch (err: any) {
      if (isDemo) {
        setConnections(MOCK_CONNECTIONS);
      } else {
        setError(err?.message || 'Failed to retrieve connection profiles from backend.');
        setConnections([]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConnections();
  }, []);

  const handleTestConnection = async (connId: string) => {
    setTestingId(connId);
    try {
      const res = await apiClient.testConnection(connId);
      setTestResults((prev) => ({ ...prev, [connId]: res }));
      setConnections((prev) =>
        prev.map((c) =>
          c.id === connId
            ? { ...c, status: 'ACTIVE', latencyMs: res.latencyMs, lastTestedAt: new Date().toISOString() }
            : c
        )
      );
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [connId]: { success: false, latencyMs: 0, message: 'Connection handshake timed out.' },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleCreated = (newConn: DatabaseConnection) => {
    setConnections((prev) => [newConn, ...prev]);
  };

  const handleRotated = (updated: DatabaseConnection) => {
    setConnections((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-infra-heading tracking-tight flex items-center gap-2">
            <span>Database Connection Profiles</span>
            <span className="px-2 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
              Zero-Exposure Secret Vault
            </span>
          </h1>
          <p className="text-xs text-infra-muted mt-1 font-mono">
            Manage source and target endpoints, test network throughput, and safely rotate credentials (FR-CON-001..004)
          </p>
        </div>

        <button
          onClick={() => setIsAddModalOpen(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors shadow-lg shadow-emerald-500/20"
        >
          <Plus size={14} />
          <span>Add Connection</span>
        </button>
      </div>

      {/* Security Architecture Callout */}
      <div className="p-4 rounded-xl bg-infra-card border border-infra-border flex items-start gap-3">
        <ShieldCheck size={20} className="text-emerald-400 shrink-0 mt-0.5" />
        <div className="text-xs space-y-1">
          <p className="text-infra-heading font-semibold font-mono">Cryptographic Secret Isolation</p>
          <p className="text-infra-muted leading-relaxed font-sans">
            Authentication credentials are stored exclusively in an isolated secure secrets store. The REST API and frontend never expose raw connection strings, usernames, or passwords. Active migration runs maintain immutable references to credential versions.
          </p>
        </div>
      </div>

      {/* Connections List */}
      <div className="grid grid-cols-1 gap-4">
        {loading && (
          <div className="p-8 rounded-xl bg-infra-card border border-infra-border flex flex-col items-center justify-center space-y-3">
            <RefreshCw size={24} className="animate-spin text-emerald-400" />
            <span className="text-xs font-mono text-infra-muted">Loading database connection profiles...</span>
          </div>
        )}

        {error && !loading && (
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-xs font-mono text-red-400 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-red-400 shrink-0" />
              <span>{error}</span>
            </div>
            <button
              onClick={loadConnections}
              className="flex items-center gap-1.5 px-3 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-200 border border-red-500/40 transition-colors"
            >
              <RefreshCw size={12} />
              <span>Retry</span>
            </button>
          </div>
        )}

        {!loading && !error && connections.length === 0 && (
          <div className="p-12 rounded-xl bg-infra-card border border-infra-border flex flex-col items-center justify-center text-center space-y-3">
            <div className="w-12 h-12 rounded-xl bg-infra-surface border border-infra-border flex items-center justify-center text-infra-muted">
              <Database size={24} />
            </div>
            <h3 className="text-sm font-bold text-infra-heading font-mono">No Connections Configured</h3>
            <p className="text-xs text-infra-muted max-w-sm">
              No source or target database connections found in this workspace. Register a MongoDB or PostgreSQL connection to begin migration planning.
            </p>
            <button
              onClick={() => setIsAddModalOpen(true)}
              className="mt-2 flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors"
            >
              <Plus size={14} />
              <span>Add Connection</span>
            </button>
          </div>
        )}

        {!loading && connections.map((conn) => {
          const isTesting = testingId === conn.id;
          const testRes = testResults[conn.id];

          return (
            <div
              key={conn.id}
              className="p-5 rounded-xl bg-infra-card border border-infra-border hover:border-infra-borderHover transition-all space-y-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-infra-surface border border-infra-border flex items-center justify-center shrink-0">
                    <Database
                      size={20}
                      className={conn.engine === 'MONGODB' ? 'text-emerald-400' : 'text-sky-400'}
                    />
                  </div>

                  <div>
                    <div className="flex items-center gap-2.5">
                      <h2 className="text-sm font-bold text-infra-heading font-mono">{conn.name}</h2>
                      <Badge
                        variant={conn.engine === 'MONGODB' ? 'emerald' : 'sky'}
                        size="sm"
                      >
                        {conn.engine}
                      </Badge>
                      <Badge variant="indigo" size="sm">
                        {conn.connectionRole}
                      </Badge>
                      <Badge
                        variant={conn.status === 'ACTIVE' ? 'emerald' : 'rose'}
                        dot
                        size="sm"
                      >
                        {conn.status}
                      </Badge>
                    </div>

                    <p className="text-xs text-infra-muted font-mono mt-1 flex items-center gap-2">
                      <span>ID: {conn.id}</span>
                      <span>•</span>
                      <span>Host: {conn.config.host}:{conn.config.port}</span>
                      <span>•</span>
                      <span>Database: {conn.config.database}</span>
                      {conn.config.schema && <span>• Schema: {conn.config.schema}</span>}
                    </p>
                  </div>
                </div>

                {/* Right Actions */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTestConnection(conn.id)}
                    disabled={isTesting}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium text-infra-text bg-infra-surface border border-infra-border hover:border-emerald-500/40 hover:text-emerald-400 transition-colors"
                  >
                    <RefreshCw size={12} className={isTesting ? 'animate-spin text-emerald-400' : ''} />
                    <span>{isTesting ? 'Testing Handshake...' : 'Test Connection'}</span>
                  </button>

                  <button
                    onClick={() => setSelectedConnectionForRotation(conn)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 transition-colors"
                  >
                    <KeyRound size={12} />
                    <span>Rotate Creds (v{conn.credentialVersion})</span>
                  </button>
                </div>
              </div>

              {/* Status details bar */}
              <div className="flex items-center justify-between pt-3 border-t border-infra-border/50 text-[11px] font-mono text-infra-muted">
                <div className="flex items-center gap-4">
                  <span>
                    Latency:{' '}
                    <strong className="text-emerald-400 font-semibold">
                      {conn.latencyMs ? `${conn.latencyMs}ms` : 'Not checked'}
                    </strong>
                  </span>
                  <span>
                    TLS Encryption:{' '}
                    <strong className={conn.config.tls ? 'text-emerald-400' : 'text-amber-400'}>
                      {conn.config.tls ? 'TLS Enabled (Mandatory)' : 'Disabled'}
                    </strong>
                  </span>
                  <span>
                    Vault Credential Version:{' '}
                    <strong className="text-infra-text">v{conn.credentialVersion}</strong>
                  </span>
                </div>

                <span>
                  Last Handshake:{' '}
                  {conn.lastTestedAt ? formatDate(conn.lastTestedAt) : 'Never'}
                </span>
              </div>

              {/* Live Test Outcome Result Box */}
              {testRes && (
                <div
                  className={`p-3 rounded-lg border text-xs font-mono flex items-center justify-between ${
                    testRes.success
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {testRes.success ? <Check size={14} className="text-emerald-400" /> : <AlertTriangle size={14} className="text-rose-400" />}
                    <span>{testRes.message}</span>
                  </div>
                  <span>Latency: {testRes.latencyMs}ms</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Credential Rotation Modal */}
      <CredentialRotationModal
        isOpen={!!selectedConnectionForRotation}
        onClose={() => setSelectedConnectionForRotation(null)}
        connection={selectedConnectionForRotation}
        onSuccess={handleRotated}
      />

      {/* Add Connection Modal */}
      <ConnectionModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}
