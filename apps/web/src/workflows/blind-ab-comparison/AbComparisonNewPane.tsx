import { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SKILLS_REGISTRY } from '@workbench/agents';
import {
  defaultAbComparisonModel,
  isAbComparisonModelAllowed,
  listAbComparisonModels,
  type AbComparisonProviderOption,
} from '@workbench/gtm-workflows';
import type { WorkflowNewPaneProps } from '../registry';
import {
  useCreateSkill,
  useCreateWorkflow,
  useSkillLibrary,
  useWorkflowCredentials,
} from '../../hooks/use-workflow';
import ArtifactSourcePicker from '../../components/ArtifactSourcePicker';

type StepName = 'comparisons' | 'configure' | 'input';

type Mode = 'text' | 'artifact';

type CustomSkillDraft = {
  title: string;
  content: string;
};

type FileWithRelativePath = File & { webkitRelativePath?: string };

const PROVIDER_WHITELIST = new Set(['openai-compatible', 'openai', 'anthropic', 'google-genai']);

const STEP_LABELS: Record<StepName, string> = {
  comparisons: 'Comparisons',
  configure: 'Configure',
  input: 'Input',
};

function StepBar({ currentStep }: { currentStep: StepName }) {
  const steps: StepName[] = ['comparisons', 'configure', 'input'];
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
          <span className={`text-[12px] font-medium ${i === index ? 'text-text' : 'text-text-3'}`}>
            {STEP_LABELS[step]}
          </span>
          {i < steps.length - 1 && <span className="mx-1 text-text-3">›</span>}
        </div>
      ))}
    </div>
  );
}

export function AbComparisonNewPane({
  workflowKind,
  tenantId,
  onCreated,
  onClose,
  seedArtifactId,
}: WorkflowNewPaneProps) {
  const [step, setStep] = useState<StepName>('comparisons');
  const [options, setOptions] = useState<AbComparisonProviderOption[]>([
    {
      credentialId: '',
      providerName: '',
      providerPlugin: '',
      skillIds: [],
      customSkills: [],
      skillVersionIds: [],
    },
    {
      credentialId: '',
      providerName: '',
      providerPlugin: '',
      skillIds: [],
      customSkills: [],
      skillVersionIds: [],
    },
  ]);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [inputMode, setInputMode] = useState<Mode>('text');
  const [textInput, setTextInput] = useState('');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>(seedArtifactId);
  const [error, setError] = useState('');
  const [skillName, setSkillName] = useState('');
  const [skillText, setSkillText] = useState('');

  const createWorkflow = useCreateWorkflow();
  const credentialsQuery = useWorkflowCredentials();
  const skillLibraryQuery = useSkillLibrary(tenantId);
  const createSkill = useCreateSkill();
  const whitelistedCredentials = useMemo(
    () => (credentialsQuery.data ?? []).filter((c) => PROVIDER_WHITELIST.has(c.providerPlugin)),
    [credentialsQuery.data]
  );

  const addSlot = () => {
    setOptions((prev) => [
      ...prev,
      {
        credentialId: '',
        providerName: '',
        providerPlugin: '',
        skillIds: [],
        customSkills: [],
        skillVersionIds: [],
      },
    ]);
  };

  const removeSlot = (index: number) => {
    setOptions((prev) => prev.filter((_, i) => i !== index));
  };

  const updateSlotCredential = useCallback(
    (index: number, credentialId: string) => {
      setOptions((prev) => {
        const next = [...prev];
        const cred = whitelistedCredentials.find((c) => c.id === credentialId);
        next[index] = {
          credentialId: cred?.id ?? '',
          providerName: cred?.providerName ?? '',
          providerPlugin: cred?.providerPlugin ?? '',
          model: defaultAbComparisonModel(cred?.providerPlugin ?? ''),
          skillIds: [],
          customSkills: [],
          skillVersionIds: [],
        };
        return next;
      });
    },
    [whitelistedCredentials]
  );

  const updateSlotModel = useCallback((index: number, model: string) => {
    setOptions((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], model };
      return next;
    });
  }, []);

  const updateOptionSkills = useCallback((index: number, skillIds: string[]) => {
    setOptions((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], skillIds };
      return next;
    });
  }, []);

  const updateOptionSkillVersions = useCallback((index: number, skillVersionIds: string[]) => {
    setOptions((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], skillVersionIds };
      return next;
    });
  }, []);

  const updateCustomSkills = useCallback((index: number, customSkills: CustomSkillDraft[]) => {
    setOptions((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], customSkills };
      return next;
    });
  }, []);

  const addCustomSkill = useCallback(
    (index: number) => {
      const nextSkills = [...(options[index]?.customSkills ?? []), { title: '', content: '' }];
      updateCustomSkills(index, nextSkills);
    },
    [options, updateCustomSkills]
  );

  const updateCustomSkill = useCallback(
    (index: number, skillIndex: number, patch: Partial<CustomSkillDraft>) => {
      const nextSkills = (options[index]?.customSkills ?? []).map((skill, i) =>
        i === skillIndex ? { ...skill, ...patch } : skill
      );
      updateCustomSkills(index, nextSkills);
    },
    [options, updateCustomSkills]
  );

  const removeCustomSkill = useCallback(
    (index: number, skillIndex: number) => {
      updateCustomSkills(
        index,
        (options[index]?.customSkills ?? []).filter((_, i) => i !== skillIndex)
      );
    },
    [options, updateCustomSkills]
  );

  const readSkillFile = useCallback(
    (index: number, skillIndex: number, file: File | undefined) => {
      if (!file) return;
      if (
        !file.name.endsWith('.md') &&
        file.type !== 'text/markdown' &&
        file.type !== 'text/plain'
      ) {
        setError('Upload markdown skill files only.');
        return;
      }
      file
        .text()
        .then((content) => {
          updateCustomSkill(index, skillIndex, {
            title:
              options[index]?.customSkills?.[skillIndex]?.title || file.name.replace(/\.md$/i, ''),
            content,
          });
        })
        .catch(() => setError('Could not read that skill file.'));
    },
    [options, updateCustomSkill]
  );

  const createTextSkill = () => {
    setError('');
    createSkill.mutate(
      { tenantId, name: skillName.trim(), text: skillText.trim() },
      {
        onSuccess: () => {
          setSkillName('');
          setSkillText('');
        },
        onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create skill'),
      }
    );
  };

  const createFileSkill = (files: FileList | null, folder: boolean) => {
    const selected = Array.from(files ?? []) as FileWithRelativePath[];
    if (selected.length === 0) return;
    const first = selected[0];
    const inferredName = folder
      ? (first.webkitRelativePath?.split('/')[0] ?? first.name.replace(/\.[^.]+$/, ''))
      : first.name.replace(/\.[^.]+$/, '');
    createSkill.mutate(
      {
        tenantId,
        name: skillName.trim() || inferredName,
        files: selected.map((file) => ({
          file,
          path: folder ? file.webkitRelativePath || file.name : file.name,
        })),
      },
      {
        onSuccess: () => setSkillName(''),
        onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create skill'),
      }
    );
  };

  const validateProviders = () => {
    const valid = options.filter((o) => o.credentialId);
    if (valid.length < 2) {
      setError('Select at least two providers to compare.');
      return false;
    }
    for (const option of valid) {
      if (!option.model) {
        setError('Select a model for each comparison.');
        return false;
      }
      if (!isAbComparisonModelAllowed(option.providerPlugin, option.model)) {
        setError(`Model ${option.model} is not available for ${option.providerName}.`);
        return false;
      }
      for (const skill of option.customSkills ?? []) {
        if (!skill.title.trim() || !skill.content.trim()) {
          setError('Custom skills need both a name and markdown content.');
          return false;
        }
      }
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
    if (step === 'comparisons') {
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
    if (step === 'configure') setStep('comparisons');
    else if (step === 'input') setStep('configure');
  };

  const handleSubmit = () => {
    setError('');
    createWorkflow.mutate(
      {
        workflowKind,
        tenantId: tenantId ?? undefined,
        providers: options
          .filter((o) => o.credentialId)
          .map((option) => ({
            ...option,
            customSkills: option.customSkills
              ?.map((skill) => ({
                title: skill.title.trim(),
                content: skill.content.trim(),
              }))
              .filter((skill) => skill.title && skill.content),
          })),
        systemPrompt: systemPrompt.trim() || undefined,
        input: {
          source: inputMode,
          text: inputMode === 'text' ? textInput.trim() : undefined,
          artifactId: inputMode === 'artifact' ? selectedArtifactId : undefined,
        },
      },
      {
        onSuccess: (workflow) => onCreated(workflow.id),
        onError: (err) =>
          setError(err instanceof Error ? err.message : 'Failed to create workflow'),
      }
    );
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
          {step === 'comparisons' && (
            <motion.div
              key="comparisons"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.12 }}
              className="space-y-4"
            >
              <p className="text-[13px] text-text-2">
                Choose how many comparisons you want and pick a provider for each slot. You can use
                the same provider multiple times.
              </p>
              {credentialsQuery.isLoading && (
                <p className="text-[13px] text-text-3">Loading credentials…</p>
              )}
              {credentialsQuery.isError && (
                <p className="text-[13px] text-orange-deep">Could not load credentials.</p>
              )}
              <div className="space-y-3">
                {options.map((option, index) => (
                  <div key={index} className="rounded-[10px] border border-border p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] font-medium text-text">
                        Comparison {index + 1}
                      </span>
                      {options.length > 2 && (
                        <button
                          type="button"
                          onClick={() => removeSlot(index)}
                          className="text-[11px] text-text-3 hover:text-red transition-colors"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <select
                      value={option.credentialId}
                      onChange={(e) => updateSlotCredential(index, e.target.value)}
                      className="w-full rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text focus:outline-none focus:ring-1 focus:ring-orange/40"
                    >
                      <option value="">Select a provider…</option>
                      {whitelistedCredentials.map((cred) => (
                        <option key={cred.id} value={cred.id}>
                          {cred.name} ({cred.providerName} · {cred.providerPlugin})
                        </option>
                      ))}
                    </select>
                    {option.credentialId && (
                      <div className="space-y-1">
                        <label className="block text-[12px] font-medium text-text">Model</label>
                        <select
                          value={option.model ?? ''}
                          onChange={(e) => updateSlotModel(index, e.target.value)}
                          className="w-full rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text focus:outline-none focus:ring-1 focus:ring-orange/40"
                        >
                          {listAbComparisonModels(option.providerPlugin).map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                        <p className="text-[11px] text-text-3">
                          {option.providerName} · {option.providerPlugin}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addSlot}
                  className="w-full rounded-[9px] border border-border bg-surface px-4 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
                >
                  Add comparison
                </button>
              </div>
              {whitelistedCredentials.length === 0 && !credentialsQuery.isLoading && (
                <p className="text-[13px] text-text-3">
                  No whitelisted credentials available. Add an OpenAI-compatible, OpenAI, or
                  Anthropic credential first.
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

              <div className="rounded-[10px] border border-border p-3 space-y-3">
                <div>
                  <p className="text-[13px] font-medium text-text">Skill library</p>
                  <p className="text-[12px] text-text-3">
                    Create reusable skills from pasted text, a markdown file, or a folder. Code and
                    non-text assets are stored as inert bundle files and are never executed.
                  </p>
                </div>
                <input
                  type="text"
                  value={skillName}
                  onChange={(e) => setSkillName(e.target.value)}
                  placeholder="Skill name (required for pasted text)"
                  className="w-full rounded-[8px] border border-border bg-surface px-3 py-2 text-[12px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
                />
                <textarea
                  value={skillText}
                  onChange={(e) => setSkillText(e.target.value)}
                  placeholder="Paste a single-file markdown skill…"
                  rows={4}
                  className="w-full resize-none rounded-[8px] border border-border bg-surface px-3 py-2 text-[12px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={createTextSkill}
                    disabled={createSkill.isPending}
                    className="rounded-[7px] border border-border px-2.5 py-1 text-[12px] font-medium text-text-2 transition-colors hover:text-text disabled:opacity-50"
                  >
                    Save pasted skill
                  </button>
                  <label className="cursor-pointer rounded-[7px] border border-border px-2.5 py-1 text-[12px] font-medium text-text-2 transition-colors hover:text-text">
                    Upload file
                    <input
                      type="file"
                      className="hidden"
                      onChange={(e) => createFileSkill(e.currentTarget.files, false)}
                    />
                  </label>
                  <label className="cursor-pointer rounded-[7px] border border-border px-2.5 py-1 text-[12px] font-medium text-text-2 transition-colors hover:text-text">
                    Upload folder
                    <input
                      type="file"
                      multiple
                      // @ts-expect-error webkitdirectory is the browser folder-upload API.
                      webkitdirectory=""
                      className="hidden"
                      onChange={(e) => createFileSkill(e.currentTarget.files, true)}
                    />
                  </label>
                </div>
              </div>

              {/* Per-provider skills */}
              <div>
                <label className="block text-[13px] font-medium text-text mb-2">
                  Skills per comparison
                </label>
                <div className="space-y-3">
                  {options.map((option, index) => (
                    <div key={index} className="rounded-[10px] border border-border p-3">
                      <p className="text-[13px] font-medium text-text mb-2">
                        {option.providerName
                          ? `Comparison ${index + 1}: ${option.providerName}`
                          : `Comparison ${index + 1}`}
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
                                updateOptionSkills(index, next);
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

                      {skillLibraryQuery.data && skillLibraryQuery.data.length > 0 && (
                        <div className="mt-3 space-y-2">
                          <p className="text-[12px] font-medium text-text">
                            Reusable library skills
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {skillLibraryQuery.data.map((skill) => {
                              const versionId = skill.latestVersionId;
                              if (!versionId) return null;
                              const active = (option.skillVersionIds ?? []).includes(versionId);
                              return (
                                <button
                                  key={skill.id}
                                  type="button"
                                  onClick={() => {
                                    const current = option.skillVersionIds ?? [];
                                    const next = active
                                      ? current.filter((id) => id !== versionId)
                                      : [...current, versionId];
                                    updateOptionSkillVersions(index, next);
                                  }}
                                  className={`rounded-[7px] border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                                    active
                                      ? 'border-green bg-green/8 text-text'
                                      : 'border-border text-text-2 hover:text-text'
                                  }`}
                                >
                                  {skill.name} v{skill.latestVersion ?? 1}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {(option.customSkills ?? []).map((skill, skillIndex) => (
                        <div
                          key={skillIndex}
                          className="mt-3 rounded-[8px] border border-border bg-surface p-3 space-y-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <input
                              type="text"
                              value={skill.title}
                              onChange={(e) =>
                                updateCustomSkill(index, skillIndex, {
                                  title: e.target.value,
                                })
                              }
                              placeholder="Skill name"
                              className="min-w-0 flex-1 rounded-[7px] border border-border bg-bg px-2.5 py-1.5 text-[12px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
                            />
                            <button
                              type="button"
                              onClick={() => removeCustomSkill(index, skillIndex)}
                              className="text-[11px] text-text-3 hover:text-red transition-colors"
                            >
                              Remove
                            </button>
                          </div>
                          <input
                            type="file"
                            accept=".md,text/markdown,text/plain"
                            onChange={(e) =>
                              readSkillFile(index, skillIndex, e.currentTarget.files?.[0])
                            }
                            className="block w-full text-[12px] text-text-3 file:mr-3 file:rounded-[7px] file:border file:border-border file:bg-surface-2 file:px-2.5 file:py-1 file:text-[12px] file:font-medium file:text-text-2"
                          />
                          <textarea
                            value={skill.content}
                            onChange={(e) =>
                              updateCustomSkill(index, skillIndex, {
                                content: e.target.value,
                              })
                            }
                            placeholder="Paste markdown skill instructions…"
                            rows={5}
                            className="w-full resize-none rounded-[7px] border border-border bg-bg px-2.5 py-1.5 text-[12px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
                          />
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addCustomSkill(index)}
                        className="mt-3 rounded-[7px] border border-border px-2.5 py-1 text-[12px] font-medium text-text-2 transition-colors hover:text-text"
                      >
                        Add custom skill
                      </button>
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
                  onSelect={(data) => setSelectedArtifactId(data.sourceArtifactId)}
                  isLoading={false}
                  initialSelectedId={selectedArtifactId}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {error && <p className="mt-3 text-[12px] text-orange-deep">{error}</p>}
      </div>

      {/* Footer actions */}
      <div className="border-t border-border bg-surface px-5 py-3 shrink-0 flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={step === 'comparisons' || createWorkflow.isPending}
          onClick={handleBack}
          className="rounded-[9px] border border-border bg-surface px-4 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          disabled={createWorkflow.isPending}
          onClick={handleNext}
          className="rounded-[9px] bg-orange px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {createWorkflow.isPending ? 'Starting…' : step === 'input' ? 'Run comparison' : 'Next'}
        </button>
      </div>
    </div>
  );
}
