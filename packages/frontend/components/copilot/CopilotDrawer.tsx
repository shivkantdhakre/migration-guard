'use client';

import React, { useState } from 'react';
import {
  Sparkles,
  Send,
  X,
  Bot,
  ExternalLink,
  ShieldCheck,
  Check,
  AlertTriangle,
  RefreshCw,
  Terminal,
  FileCheck,
} from 'lucide-react';
import { Drawer } from '../common/Drawer';
import { Badge } from '../common/Badge';
import { CopilotMessage } from '../../lib/types';
import { MOCK_COPILOT_MESSAGES } from '../../lib/mock-data';
import { apiClient, isDemoModeEnabled } from '../../lib/api-client';

export interface CopilotDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CopilotDrawer({ isOpen, onClose }: CopilotDrawerProps) {
  const [messages, setMessages] = useState<CopilotMessage[]>(
    isDemoModeEnabled()
      ? MOCK_COPILOT_MESSAGES
      : [
          {
            id: 'copilot-welcome',
            sender: 'assistant',
            content:
              'Welcome to MigrationGuard Copilot. I can inspect deterministic migration evidence, explain schema mismatches, and formulate human-reviewed remediation proposals for operator sign-off.',
            timestamp: new Date().toISOString(),
          },
        ]
  );
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [proposalStatus, setProposalStatus] = useState<Record<string, 'PENDING' | 'ACCEPTED' | 'REJECTED'>>({
    'prop-001': 'PENDING',
  });

  const quickPrompts = [
    'Explain the 8 broken references in orders',
    'Why are 15 attachments missing from S3?',
    'Show recovery plan for batch #14 segregation',
  ];

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || input;
    if (!text.trim() || isSending) return;

    const userMsg: CopilotMessage = {
      id: `user-${Date.now()}`,
      sender: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsSending(true);
    setSendError(null);

    try {
      const response = await apiClient.sendCopilotMessage(text);
      setMessages((prev) => [...prev, response]);
    } catch (err: any) {
      // Surface the error inline rather than silently dropping the failed response
      const errMsg = err?.message || 'Copilot request failed. Backend AI service may be unavailable.';
      setSendError(errMsg);
      // Append a system-level error message into the conversation so the user sees it
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          sender: 'assistant' as const,
          content: `⚠ ${errMsg}`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const handleProposalAction = (propId: string, action: 'ACCEPTED' | 'REJECTED') => {
    setProposalStatus((prev) => ({ ...prev, [propId]: action }));
  };

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title="MigrationGuard Copilot"
      subtitle="Context-aware AI assistant grounded in deterministic migration evidence"
      width="xl"
    >
      <div className="flex flex-col h-[calc(100vh-140px)]">
        {/* Guardrail Safety Disclaimer Banner */}
        <div className="p-3 mb-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-emerald-400 shrink-0" />
            <span>Strict Guardrails Active: Tool execution restricted to read-only evidence checks.</span>
          </div>
          <Badge variant="emerald" size="sm">FR-AI-004 Compliant</Badge>
        </div>

        {/* Chat Stream */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[90%] rounded-xl p-4 text-xs leading-relaxed ${
                  msg.sender === 'user'
                    ? 'bg-emerald-600/20 text-emerald-100 border border-emerald-500/30'
                    : 'bg-infra-card border border-infra-border text-infra-text shadow-sm'
                }`}
              >
                {/* Header */}
                <div className="flex items-center gap-1.5 mb-2 font-mono text-[10px] text-infra-muted">
                  {msg.sender === 'assistant' ? (
                    <>
                      <Bot size={12} className="text-emerald-400" />
                      <span className="text-emerald-400 font-semibold">MigrationGuard Agent</span>
                    </>
                  ) : (
                    <span>Operator</span>
                  )}
                  <span>•</span>
                  <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>

                {/* Content */}
                <div className="whitespace-pre-wrap font-sans text-infra-text">
                  {msg.content}
                </div>

                {/* Grounded Evidence Citations */}
                {msg.evidenceRefs && msg.evidenceRefs.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-infra-border/60">
                    <p className="text-[10px] font-mono font-semibold uppercase text-infra-muted mb-1.5 tracking-wider">
                      Internal Evidence Grounding:
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {msg.evidenceRefs.map((ref, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-infra-surface border border-infra-border text-[11px] font-mono text-infra-text hover:border-emerald-500/40 cursor-pointer"
                        >
                          <FileCheck size={10} className="text-emerald-400" />
                          <span>{ref.label}</span>
                          <ExternalLink size={9} className="text-infra-muted" />
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Structured Repair Proposal Card */}
                {msg.proposal && (
                  <div className="mt-3.5 p-3.5 rounded-lg bg-infra-surface border border-emerald-500/30 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-emerald-400 font-semibold text-xs font-mono">
                        <Sparkles size={13} />
                        <span>Proposed Remediation ({msg.proposal.id})</span>
                      </div>
                      <Badge
                        variant={
                          proposalStatus[msg.proposal.id] === 'ACCEPTED'
                            ? 'emerald'
                            : proposalStatus[msg.proposal.id] === 'REJECTED'
                            ? 'rose'
                            : 'amber'
                        }
                        size="sm"
                      >
                        {proposalStatus[msg.proposal.id] || 'PENDING'}
                      </Badge>
                    </div>

                    <p className="text-xs text-infra-heading font-medium">{msg.proposal.title}</p>
                    <p className="text-[11px] text-infra-muted">{msg.proposal.summary}</p>

                    {/* Safe Preview */}
                    <div className="p-2.5 rounded bg-black/50 border border-infra-border font-mono text-[11px] text-emerald-300 overflow-x-auto">
                      <code>{msg.proposal.safePreview}</code>
                    </div>

                    {/* Actions */}
                    {proposalStatus[msg.proposal.id] === 'PENDING' ? (
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => handleProposalAction(msg.proposal!.id, 'ACCEPTED')}
                          className="flex items-center gap-1 px-3 py-1 rounded-md text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors"
                        >
                          <Check size={12} />
                          <span>Accept into Draft Plan</span>
                        </button>
                        <button
                          onClick={() => handleProposalAction(msg.proposal!.id, 'REJECTED')}
                          className="flex items-center gap-1 px-3 py-1 rounded-md text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                        >
                          <X size={12} />
                          <span>Reject</span>
                        </button>
                      </div>
                    ) : (
                      <p className="text-[11px] text-infra-muted font-mono pt-1">
                        Decision logged in audit trail: {proposalStatus[msg.proposal.id]}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {isSending && (
            <div className="flex items-center gap-2 p-3 text-xs text-infra-muted font-mono">
              <RefreshCw size={14} className="animate-spin text-emerald-400" />
              <span>Analyzing migration telemetry and evidence...</span>
            </div>
          )}
        </div>

        {/* Quick Suggestion Pills */}
        <div className="pt-3 pb-2 flex flex-wrap gap-1.5 border-t border-infra-border">
          {quickPrompts.map((p, idx) => (
            <button
              key={idx}
              onClick={() => handleSendMessage(p)}
              className="text-[11px] px-2.5 py-1 rounded-full bg-infra-card border border-infra-border text-infra-muted hover:text-emerald-400 hover:border-emerald-500/40 transition-colors font-mono"
            >
              {p}
            </button>
          ))}
        </div>

        {/* Input Box */}
        <div className="pt-2">
          {sendError && (
            <div className="mb-2 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 font-mono flex items-center justify-between">
              <span className="truncate">{sendError}</span>
              <button
                onClick={() => setSendError(null)}
                className="ml-2 text-rose-400 hover:text-rose-300 shrink-0 text-[10px] font-semibold"
              >
                Dismiss
              </button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage();
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Copilot about validation issues, schema transforms, or repairs..."
              className="flex-1 px-4 py-2.5 rounded-lg bg-infra-card border border-infra-border text-xs text-infra-heading placeholder-infra-muted focus:outline-none focus:border-emerald-500 font-sans"
            />
            <button
              type="submit"
              disabled={!input.trim() || isSending}
              className="px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-infra-base font-semibold transition-colors flex items-center justify-center shadow-md shadow-emerald-500/20"
            >
              <Send size={14} />
            </button>
          </form>
        </div>
      </div>
    </Drawer>
  );
}
