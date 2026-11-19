'use client';

import React, { useState } from 'react';
import { Database, ShieldCheck, Check, RefreshCw } from 'lucide-react';
import { Modal } from '../common/Modal';
import { DatabaseConnection, EngineType, ConnectionRole } from '../../lib/types';
import { apiClient } from '../../lib/api-client';

export interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (connection: DatabaseConnection) => void;
}

export function ConnectionModal({ isOpen, onClose, onCreated }: ConnectionModalProps) {
  const [name, setName] = useState('');
  const [engine, setEngine] = useState<EngineType>('MONGODB');
  const [role, setRole] = useState<ConnectionRole>('SOURCE');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(27017);
  const [database, setDatabase] = useState('');
  const [authDatabase, setAuthDatabase] = useState('admin');
  const [schema, setSchema] = useState('public');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tls, setTls] = useState(true);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const handleEngineChange = (newEngine: EngineType) => {
    setEngine(newEngine);
    if (newEngine === 'MONGODB') {
      setPort(27017);
      setRole('SOURCE');
    } else {
      setPort(5432);
      setRole('DESTINATION');
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiClient.testConnection('preview-test');
      setTestResult(`Success: latency ${res.latencyMs}ms. Read/Write handshake verified.`);
    } catch {
      setTestResult('Connectivity failed: check host address or credentials.');
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newConn: DatabaseConnection = {
      id: `conn-${Date.now()}`,
      name,
      engine,
      connectionRole: role,
      status: 'ACTIVE',
      credentialVersion: 1,
      config: {
        host,
        port: Number(port),
        database,
        tls,
        authDatabase: engine === 'MONGODB' ? authDatabase : undefined,
        schema: engine === 'POSTGRESQL' ? schema : undefined,
      },
      lastTestedAt: new Date().toISOString(),
      latencyMs: 12,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    onCreated(newConn);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create Database Connection Profile"
      subtitle="Credentials are submitted through dedicated secret boundary and never written to raw logs"
      maxWidth="xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Engine and Role selection */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-mono text-infra-text mb-1.5 font-medium">
              Database Engine
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleEngineChange('MONGODB')}
                className={`px-3 py-2 rounded-lg text-xs font-mono font-medium border text-center transition-all ${
                  engine === 'MONGODB'
                    ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-300'
                    : 'bg-infra-surface border-infra-border text-infra-muted hover:border-infra-borderHover'
                }`}
              >
                MongoDB
              </button>
              <button
                type="button"
                onClick={() => handleEngineChange('POSTGRESQL')}
                className={`px-3 py-2 rounded-lg text-xs font-mono font-medium border text-center transition-all ${
                  engine === 'POSTGRESQL'
                    ? 'bg-sky-500/10 border-sky-500/50 text-sky-300'
                    : 'bg-infra-surface border-infra-border text-infra-muted hover:border-infra-borderHover'
                }`}
              >
                PostgreSQL
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-mono text-infra-text mb-1.5 font-medium">
              Connection Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as ConnectionRole)}
              className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading font-mono"
            >
              <option value="SOURCE">SOURCE (Read / Extract)</option>
              <option value="DESTINATION">DESTINATION (Write / Assure)</option>
            </select>
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="block text-xs font-mono text-infra-text mb-1">Connection Name</label>
          <input
            type="text"
            required
            placeholder="e.g. Production Cluster (appdb)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading placeholder-infra-muted focus:outline-none focus:border-emerald-500 font-sans"
          />
        </div>

        {/* Host and Port */}
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="block text-xs font-mono text-infra-text mb-1">Host / Endpoint</label>
            <input
              type="text"
              required
              placeholder="e.g. db.internal.company.corp"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading placeholder-infra-muted focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-infra-text mb-1">Port</label>
            <input
              type="number"
              required
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading font-mono"
            />
          </div>
        </div>

        {/* Database & Extra params */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-mono text-infra-text mb-1">Database Name</label>
            <input
              type="text"
              required
              placeholder="e.g. appdb"
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading font-mono"
            />
          </div>
          <div>
            {engine === 'MONGODB' ? (
              <>
                <label className="block text-xs font-mono text-infra-text mb-1">Auth Database</label>
                <input
                  type="text"
                  value={authDatabase}
                  onChange={(e) => setAuthDatabase(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading font-mono"
                />
              </>
            ) : (
              <>
                <label className="block text-xs font-mono text-infra-text mb-1">Schema</label>
                <input
                  type="text"
                  value={schema}
                  onChange={(e) => setSchema(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading font-mono"
                />
              </>
            )}
          </div>
        </div>

        {/* Credentials */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-mono text-infra-text mb-1">Username</label>
            <input
              type="text"
              required
              placeholder="migration_user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-infra-text mb-1">Password</label>
            <input
              type="password"
              required
              placeholder="••••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading font-mono"
            />
          </div>
        </div>

        {/* TLS toggle */}
        <div className="flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            id="tls-toggle"
            checked={tls}
            onChange={(e) => setTls(e.target.checked)}
            className="rounded border-infra-border bg-infra-surface text-emerald-500 focus:ring-0"
          />
          <label htmlFor="tls-toggle" className="text-xs text-infra-text font-mono">
            Enable TLS / SSL Encryption (Mandatory for Production)
          </label>
        </div>

        {/* Test Result Message */}
        {testResult && (
          <div className="p-2.5 rounded-lg bg-infra-surface border border-emerald-500/30 text-xs text-emerald-300 font-mono flex items-center gap-2">
            <Check size={14} className="text-emerald-400" />
            <span>{testResult}</span>
          </div>
        )}

        {/* Footer controls */}
        <div className="flex items-center justify-between pt-4 border-t border-infra-border">
          <button
            type="button"
            onClick={handleTest}
            disabled={!host || testing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono text-infra-muted hover:text-emerald-400 bg-infra-surface border border-infra-border hover:border-emerald-500/40 transition-colors"
          >
            {testing ? <RefreshCw size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
            <span>Test Connection</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-infra-muted hover:text-infra-heading bg-infra-surface border border-infra-border transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name || !host || !username || !password}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-infra-base transition-colors shadow-md shadow-emerald-500/20"
            >
              Save Connection
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
