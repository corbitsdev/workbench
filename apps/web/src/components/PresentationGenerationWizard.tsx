import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import RecentCallsPicker from './RecentCallsPicker';
import {
  useCreatePresentationWorkflow,
  useSubmitPresentationStep,
  useGammaTemplates,
  useGeraltInstances,
} from '../hooks/use-presentation-workflow';
import type { GammaTemplate } from '../hooks/use-presentation-workflow';
import type { AgentInstance } from '../hooks/use-workflow';
import type { IntakeRequest } from '../types/intake';

interface PresentationGenerationWizardProps {
  onCreated: (workflowId: string) => void;
  onClose: () => void;
  tenantId?: string | null;
}

type WizardStep = 'template' | 'source' | 'generate';
type SourceMode = 'paste' | 'recent';
type Tone = 'Formal' | 'Conversational' | 'Technical';

const TONES: Tone[] = ['Formal', 'Conversational', 'Technical'];

const stepFade = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.15 },
};

const STEP_LABELS: Record<WizardStep, string> = {
  template: 'Template',
  source: 'Source',
  generate: 'Generate',
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
      className={`h-[22px] w-[22px] rounded-full text-[11px] font-semibold grid place-items-center shrink-0 transition-colors ${circleClass}`}
    >
      {isDone ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3">
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
  return <span className={`text-[12px] font-medium transition-colors ${labelClass}`}>{label}</span>;
}

export function PresentationGenerationWizard({
  onCreated,
  onClose,
  tenantId,
}: PresentationGenerationWizardProps) {
  const [wizardStep, setWizardStep] = useState<WizardStep>('template');
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Template step state
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState<Tone | ''>('');
  const [goal, setGoal] = useState('');

  // Source step state
  const [sourceMode, setSourceMode] = useState<SourceMode>('recent');
  const [pasteText, setPasteText] = useState('');

  // Generate step state
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>('');

  const { data: templates, isLoading: templatesLoading } = useGammaTemplates();
  const geraltInstances = useGeraltInstances();
  const createWorkflow = useCreatePresentationWorkflow();
  const submitStep = useSubmitPresentationStep();

  const isLoading = createWorkflow.isPending || submitStep.isPending;

  const handleTemplateNext = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const run = await createWorkflow.mutateAsync({ tenantId });
      setWorkflowId(run.id);
      await submitStep.mutateAsync({
        workflowId: run.id,
        step: 'template',
        templateId: selectedTemplateId || undefined,
        audience: audience.trim() || undefined,
        tone: tone || undefined,
        goal: goal.trim() || undefined,
      });
      setWizardStep('source');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workflow');
    }
  };

  const handleSourceSubmit = async (data: IntakeRequest) => {
    if (!workflowId) return;
    setError('');
    try {
      if (data.source === 'granola') {
        await submitStep.mutateAsync({
          workflowId,
          step: 'source',
          transcriptSource: 'granola',
          granolaId: data.granolaId,
        });
      } else {
        await submitStep.mutateAsync({
          workflowId,
          step: 'source',
          transcriptSource: 'paste',
          transcript: data.transcript,
        });
      }
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

  const stepKeys: WizardStep[] = ['template', 'source', 'generate'];

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <p className="text-[14px] font-semibold text-text">Create a presentation</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-[28px] w-[28px] flex-none place-items-center rounded-[8px] border border-border text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
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

      {/* Step indicator */}
      <div className="flex gap-0 px-5 pt-4 shrink-0">
        {stepKeys.map((s, i) => {
          const isDone = stepKeys.indexOf(wizardStep) > i;
          const isCurrent = wizardStep === s;
          return (
            <div key={s} className="flex items-center gap-0">
              <div className="flex items-center gap-2">
                <StepCircle isDone={isDone} isCurrent={isCurrent} index={i} />
                <StepLabel isDone={isDone} isCurrent={isCurrent} label={STEP_LABELS[s]} />
              </div>
              {i < stepKeys.length - 1 && (
                <div
                  className={`h-px w-6 mx-2 transition-colors ${isDone ? 'bg-orange' : 'bg-border'}`}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <AnimatePresence mode="wait">
{wizardStep === 'template' && (
            <motion.form key="template" onSubmit={handleTemplateNext} className="space-y-4" {...stepFade}>
              <div>
                <p className="text-[13px] text-text-2 mb-3">
                  Pick a template to guide the deck structure, then describe the presentation goal.
                </p>

                {templatesLoading ? (
                  <div className="text-[12px] text-text-3">Loading templates…</div>
                ) : (
                  <div className="grid gap-2">
                    <label
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedTemplateId === ''
                          ? 'border-orange bg-orange/5'
                          : 'border-border hover:border-text-3'
                      }`}
                    >
                      <input
                        type="radio"
                        name="template"
                        value=""
                        checked={selectedTemplateId === ''}
                        onChange={() => setSelectedTemplateId('')}
                        className="mt-0.5 accent-orange"
                      />
                      <div>
                        <p className="text-[13px] font-medium text-text">Auto</p>
                        <p className="text-[12px] text-text-3">Let Geralt choose the best template</p>
                      </div>
                    </label>
                    {(templates ?? []).map((t: GammaTemplate) => (
                      <label
                        key={t.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          selectedTemplateId === t.id
                            ? 'border-orange bg-orange/5'
                            : 'border-border hover:border-text-3'
                        }`}
                      >
                        <input
                          type="radio"
                          name="template"
                          value={t.id}
                          checked={selectedTemplateId === t.id}
                          onChange={() => setSelectedTemplateId(t.id)}
                          className="mt-0.5 accent-orange"
                        />
                        <div>
                          <p className="text-[13px] font-medium text-text">{t.name}</p>
                          {t.description && (
                            <p className="text-[12px] text-text-3">{t.description}</p>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-text-2 mb-1">
                    audience
                    <span className="text-text-3 font-normal"> (optional)</span>
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
                    tone
                    <span className="text-text-3 font-normal"> (optional)</span>
                  </label>
                  <div className="flex gap-2">
                    {TONES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTone(tone === t ? '' : t)}
                        className={`px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors ${
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
                    goal
                    <span className="text-text-3 font-normal"> (optional)</span>
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
                disabled={isLoading}
                className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Creating…' : 'Continue'}
              </button>
            </motion.form>
          )}

{wizardStep === 'source' && (
            <motion.div key="source" className="space-y-4" {...stepFade}>
              <p className="text-[13px] text-text-2">
                Choose where the call content comes from.
              </p>

              <div className="flex gap-1 p-1 bg-surface-2 rounded-[10px] w-48">
                {(['recent', 'paste'] as SourceMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setSourceMode(m);
                      setError('');
                    }}
                    className={`flex-1 px-3 py-1.5 rounded-[8px] text-[13px] font-medium transition-colors ${
                      sourceMode === m
                        ? 'bg-surface text-text shadow-sm'
                        : 'text-text-2 hover:text-text'
                    }`}
                  >
                    {m === 'recent' ? 'Recent' : 'Paste'}
                  </button>
                ))}
              </div>

              <AnimatePresence mode="wait">
                {sourceMode === 'paste' ? (
                  <motion.form
                    key="paste"
                    onSubmit={handlePasteSourceSubmit}
                    className="space-y-3"
                    {...stepFade}
                  >
                    <textarea
                      value={pasteText}
                      onChange={(e) => {
                        setPasteText(e.target.value);
                        setError('');
                      }}
                      placeholder="Speaker 1: Thanks for taking the time today..."
                      rows={8}
                      disabled={isLoading}
                      className="w-full px-3 py-3 text-[13px] border border-border rounded-lg bg-surface-2 text-text font-mono resize-none focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
                    />
                    {error && <p className="text-[12px] text-orange">{error}</p>}
                    <button
                      type="submit"
                      disabled={isLoading || !pasteText.trim()}
                      className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isLoading ? 'Saving…' : 'Continue'}
                    </button>
                  </motion.form>
                ) : (
                  <motion.div key="recent" {...stepFade}>
                    {error && <p className="text-[12px] text-orange mb-3">{error}</p>}
                    <RecentCallsPicker
                      onSelect={handleSourceSubmit}
                      isLoading={isLoading}
                      tenantId={tenantId}
                      kind="presentation-generation"
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

{wizardStep === 'generate' && (
            <motion.form key="generate" onSubmit={handleGenerate} className="space-y-4" {...stepFade}>
              <p className="text-[13px] text-text-2">
                Pick a running presentation agent session. The brief will be dispatched into that chat.
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
                  {geraltInstances.data.map((inst: AgentInstance) => (
                    <label
                      key={inst.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
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
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {error && <p className="text-[12px] text-orange">{error}</p>}

              <button
                type="submit"
                disabled={isLoading || !selectedInstanceId}
                className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Dispatching…' : 'Send brief'}
              </button>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
