import { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  SKILLS_REGISTRY,
  type AbComparisonProviderOption,
} from '@workbench/agents';
import type { WorkflowNewPaneProps } from '../registry';
import { useWorkflowCredentials } from '../../hooks/use-workflow';
import ArtifactSourcePicker from '../../components/ArtifactSourcePicker';

type StepName = 'providers' | 'configure' | 'input';

type Mode = 'text' | 'artifact';

const PROVIDER_WHITELIST = new Set(['openai-compatible', 'openai', 'anthropic']);

const STEP_LABELS: Record<StepName, string> = {
  providers: 'Providers',
  configure: 'Configure',
  input: 'Input',
};

function StepBar({ currentStep }: { currentStep: StepName }) {
  const steps: StepName[] = ['providers', 'configure', 'input'];
  const index = steps.indexOf(currentStep);
  return (
    <div className="flex items-center gap-2 px-5 py-3 border-b border-border shrink-0">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-2">
          <div
            className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold ${
              i < index
                ? 'bg-green text-white'
                : i === index
                  ? 'bg-orange text-white'
                  : 'bg-surface-2 text-text-3'
            }`}
          >
            {i < index ? '✓' : i + 1}
          </div>
          <span
            className={`text-[12px] font-medium ${
              i === index ? 'text-text' : 'text-text-3'
            }`}
          >
            {STEP_LABELS[step]}
          </span>
          {i < steps.length - 1 && (
            <span className="mx-1 text-text-3">›</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function AbComparisonNewPane({
  tenantId,
  onCreated,
  onClose,
  seedArtifactId,
}: WorkflowNewPaneProps) {
  const [step, setStep] = useState<StepName>('providers');
  const [options, setOptions] = useState<AbComparisonProviderOption[]>([]);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [inputMode, setInputMode] = useState<Mode>('text');
  const [textInput, setTextInput] = useState('');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>(
    seedArtifactId
  );
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const credentialsQuery = useWorkflowCredentials();
  const whitelistedCredentials = useMemo(
    () =>
      (credentialsQuery.data ?? []).filter((c) =>
        PROVIDER_WHITELIST.has(c.providerPlugin)
      ),
    [credentialsQuery.data]
  );

  const toggleOption = useCallback(
    (credentialId: string) => {
      setOptions((prev) => {
        const exists = prev.find((o) => o.credentialId === credentialId);
        if (exists) {
          return prev.filter((o) => o.credentialId !== credentialId);
        }
        const cred = whitelistedCredentials.find((c) => c.id === credentialId);
        if (!cred) return prev;
        return [
          ...prev,
          {
            credentialId: cred.id,
            providerName: cred.providerName,
            providerPlugin: cred.providerPlugin,
            model: cred.model,
            skillIds: [],
          },
        ];
      });
    },
    [whitelistedCredentials]
  );

  const updateOptionSkills = useCallback(
    (credentialId: string, skillIds: string[]) => {
      setOptions((prev) =>
        prev.map((o) =>
          o.credentialId === credentialId ? { ...o, skillIds } : o
        )
      );
    },
    []
  );

  const validateProviders = () => {
    if (options.length < 2) {
      setError('Select at least two providers to compare.');
      return false;
    }
    return true;
  };

  const validateInput = () => {
    if (inputMode === 'text') {
      if (!textInput.trim()) {
        setError('Enter some text to run.');
        return false;
      }
    } else if (inputMode === 'artifact') {
      if (!selectedArtifactId) {
        setError('Select an artifact.');
        return false;
      }
    }
    return true;
  };

  const handleNext = () => {
    setError('');
    if (step === 'providers') {
      if (!validateProviders()) return;
      setStep('configure');
    } else if (step === 'configure') {
      setStep('input');
    } else if (step === 'input') {
      if (!validateInput()) return;
      handleSubmit();
    }
  };

  const handleBack = () => {
    setError('');
    if (step === 'configure') setStep('providers');
    else if (step === 'input') setStep('configure');
  };

  const handleSubmit = async () => {
    setError('');
    setIsLoading(true);
    try {
      const res = await fetch('/api/v1/workflows', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowKind: 'blind-ab-comparison',
          tenantId,
          providers: options,
          systemPrompt: systemPrompt.trim() || undefined,
          input: {
            source: inputMode,
            text: inputMode === 'text' ? textInput.trim() : undefined,
            artifactId:
              inputMode === 'artifact' ? selectedArtifactId : undefined,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { id: string };
      onCreated(data.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create workflow'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <p className="text-[14px] font-semibold text-text">New A/B Comparison</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-[28px] w-[28px] place-items-center rounded-[8px] border border-border text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-4 w-4"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <StepBar currentStep={step} />

      <div className="flex-1 overflow-y-auto p-5">
        <AnimatePresence mode="wait">
          {step === 'providers' && (
            <motion.div
              key="providers"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.12 }}
              className="space-y-4"
            >
              <p className="text-[13px] text-text-2">
                Select two or more inference providers from the whitelist
                (openai-compatible, OpenAI, Anthropic).
              </p>
              {credentialsQuery.isLoading && (
                <p className="text-[13px] text-text-3">Loading credentials…</p>
              )}
              {credentialsQuery.isError && (
                <p className="text-[13px] text-orange-deep">
                  Could not load credentials.
                </p>
              )}
              <div className="grid grid-cols-1 gap-2">
                {whitelistedCredentials.map((cred) => {
                  const active = options.some(
                    (o) => o.credentialId === cred.id
                  );
                  return (
                    <label
                      key={cred.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-[10px] border p-4 transition-colors ${
                        active
                          ? 'border-orange bg-orange/[0.06]'
                          : 'border-border hover:bg-[var(--row-hover)]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => toggleOption(cred.id)}
                        className="h-4 w-4 accent-orange"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-text">
                          {cred.name}
                        </p>
                        <p className="text-[11px] text-text-3">
                          {cred.providerName} · {cred.providerPlugin}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
              {whitelistedCredentials.length === 0 && !credentialsQuery.isLoading && (
                <p className="text-[13px] text-text-3">
                  No whitelisted credentials available. Add an OpenAI-compatible, OpenAI, or Anthropic credential first.
                </p>
              )}
            </motion.div>
          )}

          {step === 'configure' && (
            <motion.div
              key="configure"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.12 }}
              className="space-y-5"
            >
              {/* System prompt */}
              <div>
                <label className="block text-[13px] font-medium text-text mb-2">
                  Shared system prompt (optional)
                </label>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Optional instructions applied to every provider…"
                  rows={4}
                  className="w-full resize-none rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
                />
              </div>

              {/* Per-provider skills */}
              <div>
                <label className="block text-[13px] font-medium text-text mb-2">
                  Skills per provider
                </label>
                <div className="space-y-3">
                  {options.map((option) => (
                    <div
                      key={option.credentialId}
                      className="rounded-[10px] border border-border p-3"
                    >
                      <p className="text-[13px] font-medium text-text mb-2">
                        {option.providerName}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {SKILLS_REGISTRY.map((skill) => {
                          const active = option.skillIds.includes(skill.id);
                          return (
                            <button
                              key={skill.id}
                              type="button"
                              onClick={() => {
                                const next = active
                                  ? option.skillIds.filter((id) => id !== skill.id)
                                  : [...option.skillIds, skill.id];
                                updateOptionSkills(option.credentialId, next);
                              }}
                              className={`rounded-[7px] border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                                active
                                  ? 'border-orange bg-orange/8 text-text'
                                  : 'border-border text-text-2 hover:text-text'
                              }`}
                            >
                              {skill.title}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {step === 'input' && (
            <motion.div
              key="input"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.12 }}
              className="space-y-4"
            >
              {/* Mode tabs */}
              <div className="flex gap-1 p-1 bg-surface-2 rounded-[10px] w-52">
                {(['text', 'artifact'] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setInputMode(m)}
                    className={`flex-1 px-3 py-1.5 rounded-[8px] text-[13px] font-medium transition-colors ${
                      inputMode === m
                        ? 'bg-surface text-text shadow-sm'
                        : 'text-text-2 hover:text-text'
                    }`}
                  >
                    {m === 'text' ? 'Text' : 'Artifact'}
                  </button>
                ))}
              </div>

              {inputMode === 'text' ? (
                <textarea
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Paste the prompt you want to run across all providers…"
                  rows={10}
                  className="w-full resize-none rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
                />
              ) : (
                <ArtifactSourcePicker
                  tenantId={tenantId}
                  onSelect={(id) => setSelectedArtifactId(id)}
                  isLoading={false}
                  initialSelectedId={selectedArtifactId}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {error && (
          <p className="mt-3 text-[12px] text-orange-deep">{error}</p>
        )}
      </div>

      {/* Footer actions */}
      <div className="border-t border-border bg-surface px-5 py-3 shrink-0 flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={step === 'providers' || isLoading}
          onClick={handleBack}
          className="rounded-[9px] border border-border bg-surface px-4 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          disabled={isLoading}
          onClick={handleNext}
          className="rounded-[9px] bg-orange px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isLoading
            ? 'Starting…'
            : step === 'input'
              ? 'Run comparison'
              : 'Next'}
        </button>
      </div>
    </div>
  );
}
