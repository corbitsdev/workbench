import { type FormEvent, useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Input, Label } from '@workbench/auth';
import {
  provisionAgent,
  type ProvisionAgentInput,
  type ProvisionAgentResponse,
} from '../../lib/hub-api';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

type AgentType = 'oat' | 'myra';
type DeploymentScope = 'workspace' | 'personal';

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
  {
    type: 'myra',
    name: 'Myra — Personal Assistant',
    description: 'Your personal GTM assistant. Credentials stay private to you.',
    defaultScope: 'personal',
  },
];

export interface NewAgentModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (response: ProvisionAgentResponse) => void;
  /** Workspace tenant ID for shared (Oat) agents. */
  workspaceTenantId: string | null;
  /** Personal tenant ID for personal (Myra) agents. */
  personalTenantId: string | null;
}

export function NewAgentModal({
  open,
  onClose,
  onCreated,
  workspaceTenantId,
  personalTenantId,
}: NewAgentModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Step: 'pick-type' | 'configure'
  const [step, setStep] = useState<'pick-type' | 'configure'>('pick-type');
  const [selectedType, setSelectedType] = useState<AgentType | null>(null);

  // Credential fields
  const [granolaApiKey, setGranolaApiKey] = useState('');
  const [llmBaseURL, setLLMBaseURL] = useState('https://openrouter.ai/api/v1');
  const [llmApiKey, setLLMApiKey] = useState('');
  const [llmModel, setLLMModel] = useState('openai/gpt-4o');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep('pick-type');
    setSelectedType(null);
    setGranolaApiKey('');
    setLLMBaseURL('https://openrouter.ai/api/v1');
    setLLMApiKey('');
    setLLMModel('openai/gpt-4o');
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedType) return;

    const agentOption = AGENT_TYPES.find((a) => a.type === selectedType);
    if (!agentOption) return;

    const scope = agentOption.defaultScope;

    const tenantId = scope === 'workspace' ? workspaceTenantId : personalTenantId;
    if (!tenantId) {
      setError(
        scope === 'workspace'
          ? 'No workspace selected. Create a workspace first.'
          : 'Personal workspace not provisioned yet.'
      );
      return;
    }

    if (!llmApiKey.trim()) {
      setError('LLM API key is required.');
      return;
    }
    if (!llmBaseURL.trim()) {
      setError('LLM base URL is required.');
      return;
    }
    if (!llmModel.trim()) {
      setError('LLM model is required.');
      return;
    }
    if (selectedType === 'oat' && !granolaApiKey.trim()) {
      setError('Granola API key is required for Oat.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let input: ProvisionAgentInput;

      if (selectedType === 'oat') {
        input = {
          type: 'oat',
          scope: 'workspace',
          tenantId,
          granolaApiKey: granolaApiKey.trim(),
          llm: {
            baseURL: llmBaseURL.trim(),
            apiKey: llmApiKey.trim(),
            model: llmModel.trim(),
          },
        };
      } else {
        input = {
          type: 'myra',
          scope: 'personal',
          tenantId,
          llm: {
            baseURL: llmBaseURL.trim(),
            apiKey: llmApiKey.trim(),
            model: llmModel.trim(),
          },
        };
      }

      const response = await provisionAgent(input);
      reset();
      onCreated(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to provision agent. Please try again.');
      setLoading(false);
    }
  };

  const selectedOption = AGENT_TYPES.find((a) => a.type === selectedType) ?? null;

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
                  const tenantAvailable =
                    option.defaultScope === 'workspace'
                      ? workspaceTenantId !== null
                      : personalTenantId !== null;
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
                          {option.defaultScope === 'workspace'
                            ? 'Create a workspace first.'
                            : 'Personal tenant not ready.'}
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

                {selectedType === 'oat' && (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="granola-api-key">
                      Granola API key{' '}
                      <span className="text-[11px] font-normal text-text-3">(workspace-level)</span>
                    </Label>
                    <Input
                      id="granola-api-key"
                      type="password"
                      value={granolaApiKey}
                      onChange={(e) => setGranolaApiKey(e.target.value)}
                      placeholder="grn_..."
                      autoFocus
                    />
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <Label htmlFor="llm-base-url">
                    LLM base URL{' '}
                    <span className="text-[11px] font-normal text-text-3">
                      (
                      {selectedOption?.defaultScope === 'workspace'
                        ? 'workspace-level'
                        : 'personal'}
                      )
                    </span>
                  </Label>
                  <Input
                    id="llm-base-url"
                    type="url"
                    value={llmBaseURL}
                    onChange={(e) => setLLMBaseURL(e.target.value)}
                    placeholder="https://openrouter.ai/api/v1"
                    autoFocus={selectedType !== 'oat'}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="llm-api-key">LLM API key</Label>
                  <Input
                    id="llm-api-key"
                    type="password"
                    value={llmApiKey}
                    onChange={(e) => setLLMApiKey(e.target.value)}
                    placeholder="sk-..."
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="llm-model">Model</Label>
                  <Input
                    id="llm-model"
                    type="text"
                    value={llmModel}
                    onChange={(e) => setLLMModel(e.target.value)}
                    placeholder="openai/gpt-4o"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
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
