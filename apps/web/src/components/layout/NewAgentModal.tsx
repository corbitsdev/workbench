import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  provisionAgent,
  listAvailableTools,
  updateAgentTools,
  createTenantCredential,
  type ProvisionAgentResponse,
  type ToolSummary,
} from '../../lib/hub-api';
import { CredentialField } from '../CredentialField';
import { PROVIDER_REGISTRY } from '../../lib/providerRegistry';
import {
  LOOP_DEPLOY_PROMPT,
  GRANOLA_DEPLOY_PROMPT,
  GRANOLA_CAPABILITIES,
} from '@workbench/agents/browser';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

type CredentialRequirementKind = 'inference' | 'granola';

type CredentialRequirementOption = {
  id: CredentialRequirementKind;
  label: string;
  description: string;
};

interface PremadeOption {
  label: string;
  name: string;
  systemPrompt: string;
  credentialRequirements: CredentialRequirementOption[];
  defaultTools?: string[];
}

const INFERENCE_PROVIDER_PLUGINS = new Set([
  'anthropic',
  'openai',
  'google-genai',
  'openai-compatible',
]);

const INFERENCE_REQUIREMENT: CredentialRequirementOption = {
  id: 'inference',
  label: 'Inference Provider',
  description: 'LLM credential used to run the agent.',
};

const GRANOLA_REQUIREMENT: CredentialRequirementOption = {
  id: 'granola',
  label: 'Granola API Key',
  description: 'Workbench Granola credential used to read call notes.',
};

const PREMADE_OPTIONS: PremadeOption[] = [
  {
    label: 'Loop — Research Intelligence',
    name: 'Loop',
    systemPrompt: LOOP_DEPLOY_PROMPT,
    credentialRequirements: [INFERENCE_REQUIREMENT],
  },
  {
    label: 'Oat — Call Intelligence',
    name: 'Oat',
    systemPrompt: GRANOLA_DEPLOY_PROMPT,
    credentialRequirements: [INFERENCE_REQUIREMENT, GRANOLA_REQUIREMENT],
    defaultTools: [...GRANOLA_CAPABILITIES.tools],
  },
];

function formatToolName(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface NewAgentModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (response: ProvisionAgentResponse) => void;
  workbenchTenantId: string | null;
}

export function NewAgentModal({ open, onClose, onCreated, workbenchTenantId }: NewAgentModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [credentialRequirements, setCredentialRequirements] = useState<
    CredentialRequirementOption[]
  >([INFERENCE_REQUIREMENT]);
  const [selectedCredentialIdsByRequirement, setSelectedCredentialIdsByRequirement] = useState<
    Partial<Record<CredentialRequirementKind, string>>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tools
  const [availableTools, setAvailableTools] = useState<ToolSummary[]>([]);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [pendingToolCreds, setPendingToolCreds] = useState<Record<string, Record<string, string>>>(
    {}
  );

  useEffect(() => {
    if (!open) return;
    listAvailableTools()
      .then(setAvailableTools)
      .catch(() => {});
  }, [open]);

  const reset = () => {
    setName('');
    setSystemPrompt('');
    setCredentialRequirements([INFERENCE_REQUIREMENT]);
    setSelectedCredentialIdsByRequirement({});
    setLoading(false);
    setError(null);
    setSelectedTools(new Set());
    setPendingToolCreds({});
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
    setCredentialRequirements(option.credentialRequirements);
    setSelectedCredentialIdsByRequirement({});
    setSelectedTools(new Set(option.defaultTools ?? []));
  };

  // Providers needed by selected tools that don't yet have a credential selected
  const selectedToolProviders = [
    ...new Set(
      availableTools
        .filter((t) => selectedTools.has(t.name))
        .map((t) => t.providerName)
        // Exclude inference providers — those are already covered by the main credential section
        .filter((p) => !INFERENCE_PROVIDER_PLUGINS.has(p))
    ),
  ];

  const missingToolProviders = selectedToolProviders
    .map((providerName) => PROVIDER_REGISTRY.find((p) => p.name === providerName))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);

  const toggleTool = (toolName: string) => {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workbenchTenantId) return;

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
    const selectedCredentialIds = credentialRequirements.flatMap((requirement) => {
      const credentialId = selectedCredentialIdsByRequirement[requirement.id];
      return credentialId ? [credentialId] : [];
    });

    if (selectedCredentialIds.length !== credentialRequirements.length) {
      setError('Select a credential for each required agent launch need.');
      return;
    }

    // Validate tool credential fields
    for (const provider of missingToolProviders) {
      const fields = pendingToolCreds[provider.name] ?? {};
      for (const field of provider.fields) {
        if (field.required && !fields[field.key]) {
          setError(`${field.label} is required for ${provider.label}.`);
          return;
        }
      }
    }

    setLoading(true);
    setError(null);

    try {
      // Create missing tool credentials first
      for (const provider of missingToolProviders) {
        const fields = pendingToolCreds[provider.name] ?? {};
        await createTenantCredential(workbenchTenantId, {
          provider: provider.name,
          name: provider.label,
          apiKey: fields['apiKey'] ?? '',
          ...(fields['baseURL'] ? { baseURL: fields['baseURL'] } : {}),
        });
      }

      const response = await provisionAgent({
        tenantId: workbenchTenantId,
        name: trimmedName,
        systemPrompt: trimmedPrompt,
        credentialIds: selectedCredentialIds,
      });

      if (selectedTools.size > 0) {
        await updateAgentTools(workbenchTenantId, response.agentId, Array.from(selectedTools));
      }

      if (!response.launched && response.launchError) {
        setError(`Agent created but failed to start: ${response.launchError}`);
        setLoading(false);
        onCreated(response);
        return;
      }
      reset();
      onCreated(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to provision agent. Please try again.');
      setLoading(false);
    }
  };

  const selectedCredentialIds = credentialRequirements.flatMap((requirement) => {
    const credentialId = selectedCredentialIdsByRequirement[requirement.id];
    return credentialId ? [credentialId] : [];
  });

  const selectCredentialForRequirement = (
    requirementId: CredentialRequirementKind,
    credentialId: string | undefined
  ) => {
    setSelectedCredentialIdsByRequirement((current) => {
      const next = { ...current };
      if (credentialId) {
        next[requirementId] = credentialId;
      } else {
        delete next[requirementId];
      }
      return next;
    });
  };

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

            <form
              onSubmit={(e) => void handleSubmit(e)}
              className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto px-6 py-5"
            >
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

              {availableTools.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-[13px] font-medium text-text">Tools</p>
                  <div className="flex flex-wrap gap-2">
                    {availableTools.map((tool) => (
                      <label
                        key={tool.name}
                        title={tool.description}
                        className={`flex cursor-pointer items-center gap-1.5 rounded-[9px] border px-3 py-1.5 text-[13px] transition-colors ${
                          selectedTools.has(tool.name)
                            ? 'border-orange bg-[rgba(233,132,40,0.12)] text-orange'
                            : 'border-border text-text-2 hover:text-text'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedTools.has(tool.name)}
                          onChange={() => toggleTool(tool.name)}
                          disabled={loading}
                          className="h-3 w-3 accent-orange"
                        />
                        {formatToolName(tool.name)}
                      </label>
                    ))}
                  </div>

                  {missingToolProviders.length > 0 && (
                    <div className="flex flex-col gap-3">
                      {missingToolProviders.map((provider) => (
                        <div
                          key={provider.name}
                          className="rounded-[10px] border border-border bg-bg px-3 py-3"
                        >
                          <p className="mb-2 text-[12px] font-medium text-text-2">
                            {provider.label} credentials
                          </p>
                          {provider.fields.map((field) => (
                            <div key={field.key} className="mb-2">
                              <label className="mb-1 block text-[12px] text-text-3">
                                {field.label}
                                {!field.required && ' (optional)'}
                              </label>
                              <input
                                type={field.type === 'password' ? 'password' : 'text'}
                                placeholder={field.placeholder}
                                value={pendingToolCreds[provider.name]?.[field.key] ?? ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setPendingToolCreds((prev) => ({
                                    ...prev,
                                    [provider.name]: {
                                      ...prev[provider.name],
                                      [field.key]: val,
                                    },
                                  }));
                                }}
                                disabled={loading}
                                className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-orange"
                              />
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <p className="text-[13px] font-medium text-text">Credentials</p>
                <p className="text-[12px] text-text-3">
                  These credentials will be accessible to this agent at runtime.
                </p>

                {!workbenchTenantId ? (
                  <p className="text-[13px] text-text-2">
                    Create a workbench first before deploying agents.
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {credentialRequirements.map((requirement) => (
                      <CredentialField
                        key={requirement.id}
                        tenantId={workbenchTenantId}
                        providerName={
                          requirement.id === 'granola' ? 'granola' : 'openai-compatible'
                        }
                        matchProviderNames={
                          requirement.id === 'granola'
                            ? ['granola']
                            : [...INFERENCE_PROVIDER_PLUGINS]
                        }
                        label={requirement.label}
                        value={selectedCredentialIdsByRequirement[requirement.id]}
                        onChange={(credentialId) =>
                          selectCredentialForRequirement(requirement.id, credentialId)
                        }
                      />
                    ))}
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={loading || !workbenchTenantId || selectedCredentialIds.length === 0}
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
