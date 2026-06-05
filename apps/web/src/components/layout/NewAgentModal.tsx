import { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useCredentials } from '../../hooks/use-credentials';
import { CredentialPicker } from '../CredentialPicker';
import { provisionAgent, type ProvisionAgentResponse } from '../../lib/hub-api';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

type AgentType = 'oat';
type DeploymentScope = 'workspace';

interface AgentTypeOption {
  type: AgentType;
  name: string;
  description: string;
  defaultScope: DeploymentScope;
}

const AGENT_TYPES: AgentTypeOption[] = [
  {
    type: 'oat',
    name: 'Oat — Call Intelligence',
    description: 'Analyzes customer calls and generates GTM collateral for the whole workspace.',
    defaultScope: 'workspace',
  },
];

export interface NewAgentModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (response: ProvisionAgentResponse) => void;
  /** Workspace tenant ID for shared (Oat) agents. */
  workspaceTenantId: string | null;
}

export function NewAgentModal({ open, onClose, onCreated, workspaceTenantId }: NewAgentModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const [step, setStep] = useState<'pick-type' | 'configure'>('pick-type');
  const [selectedType, setSelectedType] = useState<AgentType | null>(null);
  const [selectedCredentialIds, setSelectedCredentialIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { principals, credentialsByTenant, isLoading: credentialsLoading } = useCredentials();

  // For Oat: only credentials from the workspace tenant are valid
  const workspaceCredentials =
    workspaceTenantId !== null
      ? { [workspaceTenantId]: credentialsByTenant[workspaceTenantId] ?? [] }
      : {};

  const reset = () => {
    setStep('pick-type');
    setSelectedType(null);
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

  const handleSelectType = (agentType: AgentType) => {
    setSelectedType(agentType);
    setStep('configure');
    setError(null);
  };

  const handleBack = () => {
    setStep('pick-type');
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedType || !workspaceTenantId) return;

    if (selectedCredentialIds.length === 0) {
      setError('Select at least one credential to grant to this agent.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await provisionAgent({
        type: 'oat',
        scope: 'workspace',
        tenantId: workspaceTenantId,
        credentialIds: selectedCredentialIds,
      });
      reset();
      onCreated(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to provision agent. Please try again.');
      setLoading(false);
    }
  };

  const selectedOption = AGENT_TYPES.find((a) => a.type === selectedType) ?? null;
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
            transition={{ duration: 0.18 }}
            className="flex w-full max-w-md flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)] focus:outline-none"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="flex items-center gap-3">
                {step === 'configure' && (
                  <button
                    type="button"
                    onClick={handleBack}
                    aria-label="Back"
                    className="grid h-7 w-7 flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-4 w-4"
                    >
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                )}
                <div className="text-[16px] font-bold text-text">
                  {step === 'pick-type'
                    ? 'Create agent'
                    : `Configure ${selectedOption?.name ?? 'agent'}`}
                </div>
              </div>
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

            {step === 'pick-type' ? (
              <div className="flex flex-col gap-2 px-6 py-5">
                <p className="mb-1 text-[13px] text-text-2">Choose an agent type to deploy.</p>
                {AGENT_TYPES.map((option) => {
                  const tenantAvailable = workspaceTenantId !== null;
                  return (
                    <button
                      key={option.type}
                      type="button"
                      disabled={!tenantAvailable}
                      onClick={() => handleSelectType(option.type)}
                      className="flex flex-col gap-1 rounded-[12px] border border-border px-4 py-3 text-left transition-colors hover:border-orange hover:bg-[var(--row-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[14px] font-semibold text-text">{option.name}</span>
                        <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-text-3">
                          {option.defaultScope}
                        </span>
                      </div>
                      <span className="text-[13px] text-text-2">{option.description}</span>
                      {!tenantAvailable && (
                        <span className="text-[12px] text-orange-deep">
                          Create a workspace first.
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-5">
                {error && (
                  <p className="rounded-lg border border-orange bg-orange-soft px-3 py-2 text-sm text-orange-deep">
                    {error}
                  </p>
                )}

                <div className="flex flex-col gap-2">
                  <p className="text-[13px] font-medium text-text">Select credentials to grant</p>
                  <p className="text-[12px] text-text-3">
                    These credentials will be accessible to this agent at runtime.
                  </p>

                  {!hasWorkspaceCredentials && !credentialsLoading ? (
                    <p className="text-[13px] text-text-2">
                      No credentials found for this workspace.{' '}
                      <a
                        href="/settings"
                        className="text-orange underline-offset-2 hover:underline"
                      >
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
                  disabled={loading || selectedCredentialIds.length === 0}
                  className="w-full rounded-md bg-orange px-4 py-2 text-sm font-medium text-text hover:bg-orange-deep disabled:opacity-50"
                >
                  {loading ? 'Deploying agent...' : `Deploy ${selectedOption?.name ?? 'agent'}`}
                </button>
              </form>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
