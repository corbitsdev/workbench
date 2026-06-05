import { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useCredentials } from '../../hooks/use-credentials';
import { CredentialPicker } from '../CredentialPicker';
import { provisionAgent, type ProvisionAgentResponse } from '../../lib/hub-api';
import { LOOP_DEPLOY_PROMPT } from '@workbench/agents';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

interface PremadeOption {
  label: string;
  name: string;
  systemPrompt: string;
}

const PREMADE_OPTIONS: PremadeOption[] = [
  {
    label: 'Loop — Research Intelligence',
    name: 'Loop',
    systemPrompt: LOOP_DEPLOY_PROMPT,
  },
];

export interface NewAgentModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (response: ProvisionAgentResponse) => void;
  workspaceTenantId: string | null;
}

export function NewAgentModal({ open, onClose, onCreated, workspaceTenantId }: NewAgentModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [selectedCredentialIds, setSelectedCredentialIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { principals, credentialsByTenant, isLoading: credentialsLoading } = useCredentials();

  const workspaceCredentials =
    workspaceTenantId !== null
      ? { [workspaceTenantId]: credentialsByTenant[workspaceTenantId] ?? [] }
      : {};

  const reset = () => {
    setName('');
    setSystemPrompt('');
    setSelectedCredentialIds([]);
    setLoading(false);
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onClose]
  );

  const applyPremade = (option: PremadeOption) => {
    setName(option.name);
    setSystemPrompt(option.systemPrompt);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceTenantId) return;

    const trimmedName = name.trim();
    const trimmedPrompt = systemPrompt.trim();

    if (!trimmedName) {
      setError('Agent name is required.');
      return;
    }
    if (!trimmedPrompt) {
      setError('System prompt is required.');
      return;
    }
    if (selectedCredentialIds.length === 0) {
      setError('Select at least one credential to grant to this agent.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await provisionAgent({
        tenantId: workspaceTenantId,
        name: trimmedName,
        systemPrompt: trimmedPrompt,
        credentialIds: selectedCredentialIds,
      });
      reset();
      onCreated(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to provision agent. Please try again.');
      setLoading(false);
    }
  };

  const hasWorkspaceCredentials =
    workspaceTenantId !== null && (credentialsByTenant[workspaceTenantId] ?? []).length > 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,0,0,0.55)] p-4 backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
          data-testid="new-agent-modal-scrim"
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Create agent"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="flex w-full max-w-lg flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)] focus:outline-none"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="text-[16px] font-bold text-text">Create agent</div>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close"
                className="grid h-8 w-8 flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-5">
              {error && (
                <p className="rounded-lg border border-orange bg-[rgba(233,132,40,0.16)] px-3 py-2 text-sm text-orange-deep">
                  {error}
                </p>
              )}

              {PREMADE_OPTIONS.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-[12px] font-medium uppercase tracking-[0.04em] text-text-3">
                    Premade
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {PREMADE_OPTIONS.map((opt) => (
                      <button
                        key={opt.name}
                        type="button"
                        onClick={() => applyPremade(opt)}
                        className="flex items-center gap-1.5 rounded-[9px] border border-border px-3 py-1.5 text-[13px] text-text-2 transition-colors hover:border-orange hover:text-text"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <label htmlFor="agent-name" className="text-[13px] font-medium text-text">
                  Name
                </label>
                <input
                  id="agent-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Loop"
                  className="rounded-[10px] border border-border bg-bg px-3 py-2 text-[14px] text-text outline-none placeholder:text-text-3 focus:border-orange"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="agent-prompt" className="text-[13px] font-medium text-text">
                  System prompt
                </label>
                <textarea
                  id="agent-prompt"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="You are..."
                  rows={5}
                  className="resize-none rounded-[10px] border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-orange"
                />
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-[13px] font-medium text-text">Credentials</p>
                <p className="text-[12px] text-text-3">
                  These credentials will be accessible to this agent at runtime.
                </p>

                {!workspaceTenantId ? (
                  <p className="text-[13px] text-text-2">
                    Create a workbench first before deploying agents.
                  </p>
                ) : !hasWorkspaceCredentials && !credentialsLoading ? (
                  <p className="text-[13px] text-text-2">
                    No credentials found for this workspace.{' '}
                    <a href="/settings" className="text-orange underline-offset-2 hover:underline">
                      Add credentials in Settings.
                    </a>
                  </p>
                ) : (
                  <CredentialPicker
                    principals={principals}
                    credentialsByTenant={workspaceCredentials}
                    selectedIds={selectedCredentialIds}
                    onSelect={setSelectedCredentialIds}
                    isLoading={credentialsLoading}
                  />
                )}
              </div>

              <button
                type="submit"
                disabled={loading || !workspaceTenantId || selectedCredentialIds.length === 0}
                className="w-full rounded-[9px] bg-orange px-4 py-2 text-sm font-medium text-text hover:bg-orange-deep disabled:opacity-50"
              >
                {loading ? 'Deploying...' : 'Deploy agent'}
              </button>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
