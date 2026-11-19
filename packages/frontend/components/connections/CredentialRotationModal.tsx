'use client';

import React, { useState } from 'react';
import { KeyRound, ShieldAlert, Check, RefreshCw, Lock } from 'lucide-react';
import { Modal } from '../common/Modal';
import { DatabaseConnection } from '../../lib/types';
import { apiClient } from '../../lib/api-client';

export interface CredentialRotationModalProps {
  isOpen: boolean;
  onClose: () => void;
  connection: DatabaseConnection | null;
  onSuccess: (updated: DatabaseConnection) => void;
}

export function CredentialRotationModal({
  isOpen,
  onClose,
  connection,
  onSuccess,
}: CredentialRotationModalProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isRotating, setIsRotating] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  if (!connection) return null;

  const handleRotate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsRotating(true);
    setSuccessMessage(null);

    try {
      const res = await apiClient.rotateCredentials(connection.id, {
        username: username || undefined,
        password: password || undefined,
      });

      setSuccessMessage(`Credentials securely rotated to Version ${res.newVersion}. Prior secret securely revoked.`);
      setTimeout(() => {
        onSuccess({
          ...connection,
          credentialVersion: res.newVersion,
          updatedAt: new Date().toISOString(),
        });
        onClose();
        setPassword('');
        setUsername('');
        setSuccessMessage(null);
      }, 1200);
    } catch {
      // Handled
    } finally {
      setIsRotating(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Rotate Database Credentials"
      subtitle={`Connection: ${connection.name} (Current Version: v${connection.credentialVersion})`}
      maxWidth="md"
    >
      <form onSubmit={handleRotate} className="space-y-4">
        {/* Security Alert: Passwords Never Exposed */}
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-300 flex items-start gap-2.5">
          <ShieldAlert size={16} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">Zero-Leak Credential Boundary (FR-CON-001)</p>
            <p className="text-[11px] text-amber-300/80 leading-normal">
              Existing passwords are encrypted in vault storage and never returned or rendered in the browser. Rotating creates version v{connection.credentialVersion + 1}; running migrations retain immutable versions.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-infra-text mb-1 font-mono">
            New Username (optional)
          </label>
          <input
            type="text"
            placeholder="Leave blank to keep existing user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading placeholder-infra-muted focus:outline-none focus:border-emerald-500 font-mono"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-infra-text mb-1 font-mono flex items-center gap-1.5">
            <Lock size={12} className="text-emerald-400" />
            <span>New Secret / Password</span>
          </label>
          <input
            type="password"
            required
            placeholder="Enter new database password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-infra-surface border border-infra-border text-xs text-infra-heading placeholder-infra-muted focus:outline-none focus:border-emerald-500 font-mono"
          />
        </div>

        {successMessage && (
          <div className="p-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-300 font-mono flex items-center gap-2">
            <Check size={14} className="text-emerald-400" />
            <span>{successMessage}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-infra-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-infra-muted hover:text-infra-heading bg-infra-surface border border-infra-border hover:bg-infra-cardHover transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!password || isRotating}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-infra-base transition-colors shadow-md shadow-emerald-500/20"
          >
            {isRotating ? (
              <>
                <RefreshCw size={13} className="animate-spin" />
                <span>Rotating Vault Secret...</span>
              </>
            ) : (
              <>
                <KeyRound size={13} />
                <span>Rotate to v{connection.credentialVersion + 1}</span>
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
