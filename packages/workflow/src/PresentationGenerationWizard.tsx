import { useState } from 'react';
import { AnimatePresence, motion, type Easing } from 'framer-motion';
import type { PresentationSourceData, PresentationStepArgs } from './presentation-wizard-types';

export type { PresentationSourceData } from './presentation-wizard-types';

interface CreateWorkflowMutation {
  isPending: boolean;
  mutateAsync: (args: { tenantId?: string | null | undefined }) => Promise<{ id: string }>;
}

interface SubmitStepMutation {
  isPending: boolean;
  mutateAsync: (args: PresentationStepArgs) => Promise<unknown>;
}

interface AgentInstance {
  id: string;
  agentName: string;
}

interface GeraltInstancesQuery {
  isLoading: boolean;
  data: AgentInstance[];
}

export interface GammaTemplate {
  gammaId: string;
  name: string;
  description: string | null;
}

interface GammaTemplatesQuery {
  isLoading: boolean;
  isError: boolean;
  data: GammaTemplate[] | undefined;
}

export interface PresentationGenerationWizardProps {
  onCreated: (workflowId: string) => void;
  onClose: () => void;
  tenantId?: string | null;
  createWorkflow: CreateWorkflowMutation;
  submitStep: SubmitStepMutation;
  geraltInstances: GeraltInstancesQuery;
  gammaTemplates: GammaTemplatesQuery;
  renderRecentPicker: (props: {
    onSelect: (data: PresentationSourceData) => void;
    isLoading: boolean;
  }) => React.ReactNode;
  /** When provided, the Source step offers an "Artifact" tab that picks an existing
   *  artifact as the source. The picker calls onSelect with source: 'artifact'. */
  renderArtifactPicker?: (props: {
    onSelect: (data: PresentationSourceData) => void;
    isLoading: boolean;
  }) => React.ReactNode;
  /** Preselect an existing artifact as the source (e.g. "Use in Workflow"). Opens
   *  the Source step on the Artifact tab with this artifact already chosen. */
  seedArtifactId?: string;
}

type WizardStep = 'template' | 'brief' | 'source' | 'generate';
type SourceMode = 'paste' | 'recent' | 'artifact';

const SOURCE_MODE_LABELS: Record<SourceMode, string> = {
  recent: 'Recent',
  paste: 'Paste',
  artifact: 'Artifact',
};
type Tone = 'Formal' | 'Conversational' | 'Technical';

const TONES: Tone[] = ['Formal', 'Conversational', 'Technical'];

const STEP_LABELS: Record<WizardStep, string> = {
  template: 'Template',
  brief: 'Brief',
  source: 'Source',
  generate: 'Generate',
};

const STEP_KEYS: WizardStep[] = ['template', 'brief', 'source', 'generate'];

const EASE_OUT: Easing = 'easeOut';

const stepFade = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.18, ease: EASE_OUT },
};

const tabFade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.1, ease: EASE_OUT },
};

function StepCircle({
  isDone,
  isCurrent,
  index,
}: {
  isDone: boolean;
  isCurrent: boolean;
  index: number;
}) {
  let circleClass = 'bg-surface-2 text-text-3';
  if (isDone) {
    circleClass = 'bg-surface-2 text-text-2';
  } else if (isCurrent) {
    circleClass = 'bg-orange text-white';
  }
  return (
    <div
      className={`h-[22px] w-[22px] rounded-full text-[11px] font-semibold grid place-items-center shrink-0 ${circleClass}`}
    >
      {isDone ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="h-3 w-3"
        >
          <path d="M5 12l5 5L19 7" />
        </svg>
      ) : (
        index + 1
      )}
    </div>
  );
}

function StepLabel({
  isDone,
  isCurrent,
  label,
}: {
  isDone: boolean;
  isCurrent: boolean;
  label: string;
}) {
  let labelClass = 'text-text-3';
  if (isCurrent) {
    labelClass = 'text-text';
  } else if (isDone) {
    labelClass = 'text-text-2';
  }
  return <span className={`text-[12px] font-medium ${labelClass}`}>{label}</span>;
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-[12px] text-text-3 hover:text-text-2 transition-[color]"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-3.5 w-3.5"
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
      Back
    </button>
  );
}

export function PresentationGenerationWizard({
  onCreated,
  onClose,
  tenantId,
  createWorkflow,
  submitStep,
  geraltInstances,
  gammaTemplates,
  renderRecentPicker,
  renderArtifactPicker,
  seedArtifactId,
}: PresentationGenerationWizardProps) {
  const [wizardStep, setWizardStep] = useState<WizardStep>('template');
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [useAutoTemplate, setUseAutoTemplate] = useState(true);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');

  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState<Tone | ''>('');
  const [goal, setGoal] = useState('');

  const [sourceMode, setSourceMode] = useState<SourceMode>(seedArtifactId ? 'artifact' : 'recent');
  const [pasteText, setPasteText] = useState('');

  const sourceModes: SourceMode[] = renderArtifactPicker
    ? ['recent', 'paste', 'artifact']
    : ['recent', 'paste'];

  const [selectedInstanceId, setSelectedInstanceId] = useState('');

  const handleTemplateNext = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setWizardStep('brief');
  };

  const handleBriefNext = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const run = await createWorkflow.mutateAsync({ tenantId });
      setWorkflowId(run.id);
      const templateArgs: PresentationStepArgs & { step: 'template' } = {
        workflowId: run.id,
        step: 'template',
      };
      if (!useAutoTemplate && selectedTemplateId.trim()) {
        templateArgs.templateId = selectedTemplateId.trim();
      }
      if (audience.trim()) templateArgs.audience = audience.trim();
      if (tone) templateArgs.tone = tone;
      if (goal.trim()) templateArgs.goal = goal.trim();
      await submitStep.mutateAsync(templateArgs);
      setWizardStep('source');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workflow');
    }
  };

  const handleSourceSubmit = async (data: PresentationSourceData) => {
    if (!workflowId) return;
    setError('');

    let args: PresentationStepArgs;
    if (data.source === 'granola') {
      args = {
        workflowId,
        step: 'source',
        transcriptSource: 'granola',
        ...(data.granolaId ? { granolaId: data.granolaId } : {}),
      };
    } else if (data.source === 'artifact') {
      if (!data.sourceArtifactId) {
        setError('Select an artifact to use as the source');
        return;
      }
      args = {
        workflowId,
        step: 'source',
        transcriptSource: 'artifact',
        sourceArtifactId: data.sourceArtifactId,
        ...(data.callTitle ? { callTitle: data.callTitle } : {}),
      };
    } else {
      if (!data.transcript) {
        setError('Paste a transcript of at least a few lines');
        return;
      }
      args = {
        workflowId,
        step: 'source',
        transcriptSource: 'paste',
        transcript: data.transcript,
      };
    }

    try {
      await submitStep.mutateAsync(args);
      setWizardStep('generate');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save source');
    }
  };

  const handlePasteSourceSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pasteText.trim() || pasteText.trim().length < 10) {
      setError('Paste a transcript of at least a few lines');
      return;
    }
    void handleSourceSubmit({ source: 'paste', transcript: pasteText.trim() });
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workflowId || !selectedInstanceId) return;
    setError('');
    try {
      await submitStep.mutateAsync({
        workflowId,
        step: 'generate',
        agentInstanceId: selectedInstanceId,
      });
      onCreated(workflowId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dispatch brief');
    }
  };

  const handleClose = () => {
    onClose();
  };

  const submitStepLoading = submitStep.isPending;
  const briefLoading = createWorkflow.isPending || submitStep.isPending;

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <p className="text-[14px] font-semibold text-text">Create a presentation</p>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close"
          className="grid h-[28px] w-[28px] flex-none place-items-center rounded-[8px] border border-border text-text-2 hover:text-text hover:bg-surface-2 transition-[color,background-color]"
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

      <div className="flex gap-0 px-5 pt-4 shrink-0">
        {STEP_KEYS.map((s, i) => {
          const isDone = STEP_KEYS.indexOf(wizardStep) > i;
          const isCurrent = wizardStep === s;
          return (
            <div key={s} className="flex items-center gap-0">
              <div className="flex items-center gap-2">
                <StepCircle isDone={isDone} isCurrent={isCurrent} index={i} />
                <StepLabel isDone={isDone} isCurrent={isCurrent} label={STEP_LABELS[s]} />
              </div>
              {i < STEP_KEYS.length - 1 && (
                <div className={`h-px w-6 mx-2 ${isDone ? 'bg-orange' : 'bg-border'}`} />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <AnimatePresence mode="wait" initial={false}>
          {wizardStep === 'template' && (
            <motion.form
              key="template"
              onSubmit={handleTemplateNext}
              className="space-y-4"
              {...stepFade}
            >
              <p className="text-[13px] text-text-2">
                Choose a template to guide the deck structure, or let Geralt decide.
              </p>
              <div className="grid gap-2">
                <div
                  role="radio"
                  aria-checked={useAutoTemplate}
                  tabIndex={0}
                  onClick={() => setUseAutoTemplate(true)}
                  onKeyDown={(e) => e.key === 'Enter' && setUseAutoTemplate(true)}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-[background-color,border-color] ${
                    useAutoTemplate
                      ? 'border-orange bg-orange/5'
                      : 'border-border hover:border-text-3'
                  }`}
                >
                  <div
                    className={`mt-0.5 h-4 w-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                      useAutoTemplate ? 'border-orange' : 'border-border'
                    }`}
                  >
                    {useAutoTemplate && <div className="h-2 w-2 rounded-full bg-orange" />}
                  </div>
                  <div>
                    <p className="text-[13px] font-medium text-text">Auto</p>
                    <p className="text-[12px] text-text-3">Let Geralt choose the best template</p>
                  </div>
                </div>

                {gammaTemplates.isLoading && (
                  <div className="text-[12px] text-text-3 py-2">Loading templates…</div>
                )}
                {!gammaTemplates.isLoading && gammaTemplates.isError && (
                  <div className="text-[12px] text-text-3 py-2">
                    Could not load templates — Gamma credential may not be configured.
                  </div>
                )}
                {!gammaTemplates.isLoading &&
                  !gammaTemplates.isError &&
                  (gammaTemplates.data ?? []).map((tmpl) => (
                    <div
                      key={tmpl.gammaId}
                      role="radio"
                      aria-checked={selectedTemplateId === tmpl.gammaId}
                      tabIndex={0}
                      onClick={() => {
                        setUseAutoTemplate(false);
                        setSelectedTemplateId(tmpl.gammaId);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setUseAutoTemplate(false);
                          setSelectedTemplateId(tmpl.gammaId);
                        }
                      }}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-[background-color,border-color] ${
                        selectedTemplateId === tmpl.gammaId
                          ? 'border-orange bg-orange/5'
                          : 'border-border hover:border-text-3'
                      }`}
                    >
                      <div
                        className={`mt-0.5 h-4 w-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                          selectedTemplateId === tmpl.gammaId ? 'border-orange' : 'border-border'
                        }`}
                      >
                        {selectedTemplateId === tmpl.gammaId && (
                          <div className="h-2 w-2 rounded-full bg-orange" />
                        )}
                      </div>
                      <div>
                        <p className="text-[13px] font-medium text-text">{tmpl.name}</p>
                        {tmpl.description && (
                          <p className="text-[12px] text-text-3">{tmpl.description}</p>
                        )}
                      </div>
                    </div>
                  ))}
              </div>

              {error && <p className="text-[12px] text-orange">{error}</p>}

              <button type="submit" className="w-full btn-primary">
                Continue
              </button>
            </motion.form>
          )}

          {wizardStep === 'brief' && (
            <motion.form key="brief" onSubmit={handleBriefNext} className="space-y-4" {...stepFade}>
              <div className="flex items-center justify-between">
                <p className="text-[13px] text-text-2">Describe the presentation goal.</p>
                <BackButton
                  onClick={() => {
                    setError('');
                    setWizardStep('template');
                  }}
                />
              </div>
              <div className="grid gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-text-2 mb-1">
                    audience <span className="text-text-3 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={audience}
                    onChange={(e) => setAudience(e.target.value)}
                    placeholder="e.g. Enterprise CTOs"
                    className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-orange"
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-text-2 mb-1">
                    tone <span className="text-text-3 font-normal">(optional)</span>
                  </label>
                  <div className="flex gap-2">
                    {TONES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTone(tone === t ? '' : t)}
                        className={`px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-[background-color,border-color,color] ${
                          tone === t
                            ? 'border-orange bg-orange/5 text-text'
                            : 'border-border text-text-2 hover:border-text-3 hover:text-text'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-text-2 mb-1">
                    goal <span className="text-text-3 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder="e.g. Close the deal"
                    className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-orange"
                  />
                </div>
              </div>

              {error && <p className="text-[12px] text-orange">{error}</p>}

              <button
                type="submit"
                disabled={briefLoading}
                className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {briefLoading ? 'Creating…' : 'Continue'}
              </button>
            </motion.form>
          )}

          {wizardStep === 'source' && (
            <motion.div key="source" className="space-y-4" {...stepFade}>
              <p className="text-[13px] text-text-2">Choose the source for this presentation.</p>

              <div className="flex gap-1 p-1 bg-surface-2 rounded-[10px] w-fit">
                {sourceModes.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setSourceMode(m);
                      setError('');
                    }}
                    className={`flex-1 px-3 py-1.5 rounded-[8px] text-[13px] font-medium transition-[background-color,color] ${
                      sourceMode === m
                        ? 'bg-surface text-text shadow-sm'
                        : 'text-text-2 hover:text-text'
                    }`}
                  >
                    {SOURCE_MODE_LABELS[m]}
                  </button>
                ))}
              </div>

              <AnimatePresence mode="wait">
                {sourceMode === 'paste' && (
                  <motion.form
                    key="paste"
                    onSubmit={handlePasteSourceSubmit}
                    className="space-y-3"
                    {...tabFade}
                  >
                    <textarea
                      value={pasteText}
                      onChange={(e) => {
                        setPasteText(e.target.value);
                        setError('');
                      }}
                      placeholder="Speaker 1: Thanks for taking the time today..."
                      rows={8}
                      disabled={submitStepLoading}
                      className="w-full px-3 py-3 text-[13px] border border-border rounded-lg bg-surface-2 text-text font-mono resize-none focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
                    />
                    {error && <p className="text-[12px] text-orange">{error}</p>}
                    <button
                      type="submit"
                      disabled={submitStepLoading || !pasteText.trim()}
                      className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {submitStepLoading ? 'Saving…' : 'Continue'}
                    </button>
                  </motion.form>
                )}
                {sourceMode === 'recent' && (
                  <motion.div key="recent" {...tabFade}>
                    {error && <p className="text-[12px] text-orange mb-3">{error}</p>}
                    {renderRecentPicker({
                      onSelect: handleSourceSubmit,
                      isLoading: submitStepLoading,
                    })}
                  </motion.div>
                )}
                {sourceMode === 'artifact' && renderArtifactPicker && (
                  <motion.div key="artifact" {...tabFade}>
                    {error && <p className="text-[12px] text-orange mb-3">{error}</p>}
                    {renderArtifactPicker({
                      onSelect: handleSourceSubmit,
                      isLoading: submitStepLoading,
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {wizardStep === 'generate' && (
            <motion.form
              key="generate"
              onSubmit={handleGenerate}
              className="space-y-4"
              {...stepFade}
            >
              <p className="text-[13px] text-text-2">
                Pick a running presentation agent session. The brief will be dispatched into that
                chat.
              </p>

              {geraltInstances.isLoading ? (
                <div className="text-[12px] text-text-3">Loading agents…</div>
              ) : geraltInstances.data.length === 0 ? (
                <div className="rounded-lg border border-border bg-surface-2 px-4 py-3">
                  <p className="text-[13px] text-text-2">No presentation agents are running.</p>
                  <p className="text-[12px] text-text-3 mt-1">
                    Launch a presentation agent from the agent panel, then come back.
                  </p>
                </div>
              ) : (
                <div className="grid gap-2">
                  {geraltInstances.data.map((inst, idx) => (
                    <label
                      key={inst.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-[background-color,border-color] ${
                        selectedInstanceId === inst.id
                          ? 'border-orange bg-orange/5'
                          : 'border-border hover:border-text-3'
                      }`}
                    >
                      <input
                        type="radio"
                        name="instance"
                        value={inst.id}
                        checked={selectedInstanceId === inst.id}
                        onChange={() => setSelectedInstanceId(inst.id)}
                        className="mt-0.5 accent-orange"
                      />
                      <div>
                        <p className="text-[13px] font-medium text-text">{inst.agentName}</p>
                        <p className="text-[12px] text-text-3">Session {idx + 1}</p>
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {error && <p className="text-[12px] text-orange">{error}</p>}

              <button
                type="submit"
                disabled={submitStepLoading || !selectedInstanceId}
                className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitStepLoading ? 'Dispatching…' : 'Send brief'}
              </button>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
