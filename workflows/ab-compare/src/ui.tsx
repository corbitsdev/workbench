import { type ReactNode, useState, useCallback, useMemo } from 'react';
import { type } from 'arktype';
import type { RunState, StepState } from '@intx/workflow';
import {
  Button,
  HorizontalStepper,
  Markdown,
  type WorkflowCredential,
  type WorkflowPanelProps,
  type WorkflowSkill,
  type WorkflowStep,
} from '@workbench/ui';
import {
  defaultAbComparisonModel,
  isAbComparisonModelAllowed,
  listAbComparisonModels,
} from './models';

const CONFIG_SIGNAL = 'ab-config';
const REVIEW_SIGNAL = 'comparison-review';

const STEP_ORDER = ['config', 'execute', 'compare', 'review', 'persist'] as const;
type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  config: 'Configure',
  execute: 'Execute',
  compare: 'Compare',
  review: 'Review',
  persist: 'Persist',
};

// The payload sent on the ab-config signal.
interface VariantConfig {
  label: string;
  providerName: string;
  model: string;
  systemPrompt?: string;
  skillIds?: string[];
  input: string;
}

// Inline-inference step output shape: { reply: string, turn?: unknown }.
const AgentStepOutput = type({ reply: 'string', 'turn?': 'unknown' });
// The execute map emits an array of per-variant agent outputs.
const ExecuteMapOutput = AgentStepOutput.array();

// The compare agent emits STRICT JSON in its reply.
const CompareJSON = type({
  'summary?': 'string',
  'ranking?': type({
    rank: 'number',
    label: 'string',
    'rationale?': 'string',
  }).array(),
  'recommendation?': 'string',
});

// The config signal payload we read back for the reveal.
const ConfigPayload = type({
  variants: type({
    label: 'string',
    providerName: 'string',
    model: 'string',
    'systemPrompt?': 'string',
    'skillIds?': 'string[]',
    input: 'string',
  }).array(),
  input: 'string',
});

// `deterministicToolStep` output: { callId: string, content: "<JSON string>" }.
const ToolResultEnvelope = type({ callId: 'string', content: 'string' });

const PersistContent = type({
  'artifactId?': 'string',
  'title?': 'string',
  'kind?': 'string',
  'version?': 'number',
});

type StepPhase = StepState['phase'];

function phaseFor(state: RunState | null, stepId: StepKey): StepPhase | undefined {
  return state?.steps.get(stepId)?.phase;
}

function toStepperStatus(phase: StepPhase | undefined): WorkflowStep['status'] {
  if (phase === 'completed') return 'completed';
  if (phase === 'in-flight' || phase === 'awaiting-signal' || phase === 'awaiting-timer') {
    return 'current';
  }
  return 'pending';
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return STEP_ORDER.map((stepId, index) => ({
    number: index + 1,
    label: STEP_LABELS[stepId],
    status: toStepperStatus(phaseFor(state, stepId)),
  }));
}

function activeStep(state: RunState | null): StepKey {
  for (const id of STEP_ORDER) {
    if (phaseFor(state, id) !== 'completed') return id;
  }
  return 'persist';
}

// ── Shared layout ────────────────────────────────────────────────────────────

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-panel border border-border bg-surface p-6">{children}</section>
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-4 text-sm font-medium text-text">{children}</h3>;
}

function LoadingState({ label }: { label: string }) {
  return (
    <Card>
      <p className="text-sm text-text-3">{label}</p>
    </Card>
  );
}

// ── Config wizard step bar ────────────────────────────────────────────────────

type ConfigStep = 'comparisons' | 'configure' | 'input';

const CONFIG_STEP_LABELS: Record<ConfigStep, string> = {
  comparisons: 'Comparisons',
  configure: 'Configure',
  input: 'Input',
};

function ConfigStepBar({ currentStep }: { currentStep: ConfigStep }) {
  const steps: ConfigStep[] = ['comparisons', 'configure', 'input'];
  const index = steps.indexOf(currentStep);
  return (
    <div className="flex items-center gap-2 pb-4 shrink-0">
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
            {CONFIG_STEP_LABELS[step]}
          </span>
          {i < steps.length - 1 && <span className="mx-1 text-text-3">›</span>}
        </div>
      ))}
    </div>
  );
}

// ── Config wizard state ───────────────────────────────────────────────────────

const PROVIDER_WHITELIST = new Set(['openai-compatible', 'openai', 'anthropic', 'google-genai']);

interface SlotState {
  credentialId: string;
  providerName: string;
  providerPlugin: string;
  model: string;
  skillIds: string[];
}

function emptySlot(): SlotState {
  return {
    credentialId: '',
    providerName: '',
    providerPlugin: '',
    model: '',
    skillIds: [],
  };
}

// ── Config screen ─────────────────────────────────────────────────────────────

function ConfigScreen({
  phase,
  connected,
  signalPending,
  credentials,
  skills,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  credentials: WorkflowCredential[] | undefined;
  skills: WorkflowSkill[] | undefined;
  onSubmit: (payload: { variants: VariantConfig[]; input: string }) => void;
}) {
  const [configStep, setConfigStep] = useState<ConfigStep>('comparisons');
  const [slots, setSlots] = useState<SlotState[]>([emptySlot(), emptySlot()]);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [textInput, setTextInput] = useState('');
  const [error, setError] = useState('');

  const whitelisted = useMemo(
    () => (credentials ?? []).filter((c) => PROVIDER_WHITELIST.has(c.providerPlugin)),
    [credentials]
  );

  const updateSlotCredential = useCallback(
    (index: number, credentialId: string) => {
      setSlots((prev) => {
        const next = [...prev];
        const cred = whitelisted.find((c) => c.id === credentialId);
        const providerName = cred?.providerName ?? '';
        const providerPlugin = cred?.providerPlugin ?? '';
        next[index] = {
          credentialId: cred?.id ?? '',
          providerName,
          providerPlugin,
          model: defaultAbComparisonModel(providerName, providerPlugin) ?? '',
          skillIds: next[index]!.skillIds,
        };
        return next;
      });
    },
    [whitelisted]
  );

  const updateSlotModel = useCallback((index: number, model: string) => {
    setSlots((prev) => {
      const next = [...prev];
      next[index] = { ...next[index]!, model };
      return next;
    });
  }, []);

  const toggleSlotSkill = useCallback((index: number, skillId: string) => {
    setSlots((prev) => {
      const next = [...prev];
      const current = next[index]!.skillIds;
      next[index] = {
        ...next[index]!,
        skillIds: current.includes(skillId)
          ? current.filter((id) => id !== skillId)
          : [...current, skillId],
      };
      return next;
    });
  }, []);

  const addSlot = () => {
    setSlots((prev) => [...prev, emptySlot()]);
  };

  const removeSlot = (index: number) => {
    setSlots((prev) => prev.filter((_, i) => i !== index));
  };

  const handleNext = () => {
    setError('');
    if (configStep === 'comparisons') {
      const filled = slots.filter((s) => s.credentialId);
      if (filled.length < 2) {
        setError('Select at least two providers to compare.');
        return;
      }
      for (const s of filled) {
        if (!s.model) {
          setError('Select a model for each comparison.');
          return;
        }
        if (!isAbComparisonModelAllowed(s.providerName, s.providerPlugin, s.model)) {
          setError(`Model ${s.model} is not available for ${s.providerName}.`);
          return;
        }
      }
      setConfigStep('configure');
    } else if (configStep === 'configure') {
      setConfigStep('input');
    } else if (configStep === 'input') {
      if (!textInput.trim()) {
        setError('Enter some text to run.');
        return;
      }
      const sharedInput = textInput.trim();
      const variants: VariantConfig[] = slots
        .filter((s) => s.credentialId)
        .map((s, i) => ({
          label: `Variant ${i + 1}`,
          providerName: s.providerName,
          model: s.model,
          input: sharedInput,
          ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
          ...(s.skillIds.length > 0 ? { skillIds: s.skillIds } : {}),
        }));
      onSubmit({ variants, input: sharedInput });
    }
  };

  const handleBack = () => {
    setError('');
    if (configStep === 'configure') setConfigStep('comparisons');
    else if (configStep === 'input') setConfigStep('configure');
  };

  if (phase !== 'awaiting-signal') {
    return <LoadingState label="Waiting for the run to start…" />;
  }

  return (
    <div className="flex flex-col h-full">
      <Card>
        <ConfigStepBar currentStep={configStep} />

        {configStep === 'comparisons' && (
          <div className="space-y-4">
            <p className="text-[13px] text-text-2">
              Choose how many comparisons you want and pick a provider for each slot.
            </p>
            {credentials === undefined && (
              <p className="text-[13px] text-text-3">Loading credentials…</p>
            )}
            <div className="space-y-3">
              {slots.map((slot, index) => (
                <div key={index} className="rounded-[10px] border border-border p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-text">
                      Comparison {index + 1}
                    </span>
                    {slots.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeSlot(index)}
                        className="text-[11px] text-text-3 hover:text-orange transition-colors"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <select
                    value={slot.credentialId}
                    onChange={(e) => updateSlotCredential(index, e.target.value)}
                    className="w-full rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text focus:outline-none focus:ring-1 focus:ring-orange/40"
                  >
                    <option value="">Select a provider…</option>
                    {whitelisted.map((cred) => (
                      <option key={cred.id} value={cred.id}>
                        {cred.name} ({cred.providerName} · {cred.providerPlugin})
                      </option>
                    ))}
                  </select>
                  {slot.credentialId && (
                    <div className="space-y-1">
                      <label className="block text-[12px] font-medium text-text">Model</label>
                      <select
                        value={slot.model}
                        onChange={(e) => updateSlotModel(index, e.target.value)}
                        className="w-full rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text focus:outline-none focus:ring-1 focus:ring-orange/40"
                      >
                        {listAbComparisonModels(slot.providerName, slot.providerPlugin).map(
                          (model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          )
                        )}
                      </select>
                      <p className="text-[11px] text-text-3">
                        {slot.providerName} · {slot.providerPlugin}
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
            {whitelisted.length === 0 && credentials !== undefined && (
              <p className="text-[13px] text-text-3">
                No inference credentials available. Add an OpenAI-compatible, OpenAI, Anthropic, or
                Google credential first.
              </p>
            )}
          </div>
        )}

        {configStep === 'configure' && (
          <div className="space-y-5">
            <div>
              <label className="block text-[13px] font-medium text-text mb-2">
                Shared system prompt (optional)
              </label>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Optional instructions applied to every provider…"
                rows={4}
                className="w-full resize-none rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-text mb-2">
                Skill per comparison (optional)
              </label>
              <div className="space-y-3">
                {slots.map((slot, realIndex) => {
                  if (!slot.credentialId) return null;
                  const displayIndex = slots
                    .slice(0, realIndex)
                    .filter((s) => s.credentialId).length;
                  return (
                    <div key={realIndex} className="rounded-[10px] border border-border p-3">
                      <p className="text-[13px] font-medium text-text mb-2">
                        {slot.providerName
                          ? `Comparison ${displayIndex + 1}: ${slot.providerName}`
                          : `Comparison ${displayIndex + 1}`}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {(skills ?? []).map((skill) => {
                          const active = slot.skillIds.includes(skill.id);
                          return (
                            <button
                              key={skill.id}
                              type="button"
                              onClick={() => toggleSlotSkill(realIndex, skill.id)}
                              className={`rounded-[7px] border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                                active
                                  ? 'border-orange bg-orange/8 text-text'
                                  : 'border-border text-text-2 hover:text-text'
                              }`}
                            >
                              {skill.displayName ?? skill.name}
                            </button>
                          );
                        })}
                      </div>
                      {skills === undefined && (
                        <p className="text-[12px] text-text-3">Loading skills…</p>
                      )}
                      {skills !== undefined && skills.length === 0 && (
                        <p className="text-[12px] text-text-3">No skills in the library yet.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {configStep === 'input' && (
          <div className="space-y-3">
            <p className="text-[13px] text-text-2">
              Enter the shared prompt to run across all providers.
            </p>
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Paste the prompt you want to run across all providers…"
              rows={10}
              className="w-full resize-none rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
            />
          </div>
        )}

        {error && <p className="mt-3 text-[12px] text-orange">{error}</p>}

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={configStep === 'comparisons' || signalPending}
            onClick={handleBack}
            className="rounded-[9px] border border-border bg-surface px-4 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
          >
            Back
          </button>
          <button
            type="button"
            disabled={!connected || signalPending}
            onClick={handleNext}
            className="rounded-[9px] bg-orange px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {signalPending ? 'Starting…' : configStep === 'input' ? 'Run comparison' : 'Next'}
          </button>
        </div>
        {!connected && (
          <p className="mt-2 text-xs text-text-3">Reconnecting — input unavailable.</p>
        )}
      </Card>
    </div>
  );
}

function VariantOutputs({ output }: { output: unknown }) {
  const parsed = ExecuteMapOutput(output);
  if (parsed instanceof type.errors || parsed.length === 0) return null;
  return (
    <Card>
      <CardTitle>Variant outputs</CardTitle>
      <p className="mb-4 text-xs text-text-3">
        Outputs are shown anonymously. Provider and model stay hidden through ranking.
      </p>
      <div className="space-y-4">
        {parsed.map((variant, index) => (
          <div key={index} className="rounded-lg border border-border bg-surface-2 p-3">
            <p className="mb-2 text-xs font-medium text-text-2">Variant {index + 1}</p>
            <Markdown>{variant.reply}</Markdown>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ExecuteScreen({ phase }: { phase: StepPhase | undefined }) {
  if (phase !== 'completed') {
    return <LoadingState label="Running the prompt across variants…" />;
  }
  return <LoadingState label="Variants finished — preparing the blind ranking…" />;
}

function CompareScreen({ phase, output }: { phase: StepPhase | undefined; output: unknown }) {
  if (phase === 'in-flight' || phase === undefined) {
    return <LoadingState label="Generating blind ranking…" />;
  }

  const parsed = AgentStepOutput(output);
  if (parsed instanceof type.errors) {
    if (phase === 'completed') {
      return (
        <Card>
          <p className="text-sm text-orange">Couldn't read the comparison output.</p>
        </Card>
      );
    }
    return <LoadingState label="Generating blind ranking…" />;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(parsed.reply);
  } catch {
    decoded = undefined;
  }

  const structured = decoded !== undefined ? CompareJSON(decoded) : undefined;
  const rich =
    structured !== undefined && !(structured instanceof type.errors) ? structured : undefined;

  if (rich !== undefined) {
    return (
      <Card>
        <CardTitle>Blind ranking</CardTitle>
        {rich.summary !== undefined && <p className="mb-4 text-sm text-text-2">{rich.summary}</p>}
        {rich.ranking !== undefined && rich.ranking.length > 0 ? (
          <ol className="space-y-2">
            {rich.ranking.map((entry, index) => (
              <li
                key={index}
                className="flex gap-3 rounded-lg border border-border bg-surface-2 p-3"
              >
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-orange text-xs font-medium text-white">
                  {entry.rank}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text">{entry.label}</p>
                  {entry.rationale !== undefined && (
                    <p className="text-sm text-text-3">{entry.rationale}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        {rich.recommendation !== undefined && (
          <p className="mt-4 text-sm text-text-2">{rich.recommendation}</p>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Blind ranking</CardTitle>
      <Markdown>{parsed.reply}</Markdown>
    </Card>
  );
}

function ReviewScreen({
  phase,
  compareOutput,
  executeOutput,
  connected,
  signalPending,
  onApprove,
  onSkip,
}: {
  phase: StepPhase | undefined;
  compareOutput: unknown;
  executeOutput: unknown;
  connected: boolean;
  signalPending: boolean;
  onApprove: () => void;
  onSkip: () => void;
}) {
  if (phase !== 'awaiting-signal' && phase !== 'in-flight') {
    return <LoadingState label="Waiting for comparison to finish…" />;
  }

  return (
    <div className="space-y-4">
      <VariantOutputs output={executeOutput} />
      <CompareScreen phase="completed" output={compareOutput} />

      <Card>
        <CardTitle>Review and approve</CardTitle>
        <p className="mb-4 text-sm text-text-2">
          Review the blind ranking above. Approve to save the results as an artifact, or skip to
          discard.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            disabled={!connected || signalPending || phase !== 'awaiting-signal'}
            onClick={onApprove}
          >
            Approve comparison
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!connected || signalPending || phase !== 'awaiting-signal'}
            onClick={onSkip}
          >
            Skip
          </Button>
          {!connected && (
            <p className="text-xs text-text-3">Reconnecting — approval unavailable.</p>
          )}
        </div>
      </Card>
    </div>
  );
}

// ── Reveal section ────────────────────────────────────────────────────────────

function RevealSection({
  configOutput,
  compareOutput,
}: {
  configOutput: unknown;
  compareOutput: unknown;
}) {
  const configParsed = ConfigPayload(configOutput);
  if (configParsed instanceof type.errors) return null;

  const compareParsed = AgentStepOutput(compareOutput);
  if (compareParsed instanceof type.errors) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(compareParsed.reply);
  } catch {
    decoded = undefined;
  }

  const structured = decoded !== undefined ? CompareJSON(decoded) : undefined;
  const ranking =
    structured !== undefined && !(structured instanceof type.errors)
      ? (structured.ranking ?? [])
      : [];

  const { variants } = configParsed;

  return (
    <Card>
      <CardTitle>Reveal</CardTitle>
      <p className="mb-4 text-sm text-text-2">Here is what was behind each variant.</p>
      <div className="space-y-2">
        {variants.map((variant, i) => {
          const rank = ranking.find((r) => r.label === `Variant ${i + 1}`);
          return (
            <div
              key={i}
              className="flex items-start gap-3 rounded-lg border border-border bg-surface-2 p-3"
            >
              {rank !== undefined && (
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-orange text-xs font-medium text-white">
                  #{rank.rank}
                </span>
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{variant.label}</p>
                <p className="text-xs text-text-2">
                  {variant.providerName} · {variant.model}
                </p>
                {variant.skillIds !== undefined && variant.skillIds.length > 0 && (
                  <p className="text-xs text-text-3">Skills: {variant.skillIds.join(', ')}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function PersistScreen({
  phase,
  output,
  configOutput,
  compareOutput,
  onClose,
}: {
  phase: StepPhase | undefined;
  output: unknown;
  configOutput: unknown;
  compareOutput: unknown;
  onClose: () => void;
}) {
  if (phase === 'in-flight' || phase === undefined) {
    return <LoadingState label="Saving artifact…" />;
  }

  const envelope = ToolResultEnvelope(output);
  if (envelope instanceof type.errors) {
    if (phase === 'completed') {
      return (
        <Card>
          <p className="text-sm text-orange">Couldn't read the saved artifact.</p>
        </Card>
      );
    }
    return <LoadingState label="Saving artifact…" />;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.content);
  } catch {
    decoded = undefined;
  }

  const artifact = decoded !== undefined ? PersistContent(decoded) : undefined;
  const saved = artifact !== undefined && !(artifact instanceof type.errors) ? artifact : undefined;

  return (
    <div className="space-y-4">
      <RevealSection configOutput={configOutput} compareOutput={compareOutput} />
      <Card>
        <CardTitle>Comparison saved</CardTitle>
        {saved !== undefined ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 p-3">
            <span className="min-w-0 truncate text-sm text-text">
              {saved.title ?? saved.artifactId ?? 'Saved artifact'}
            </span>
            {saved.kind !== undefined && <span className="text-xs text-text-3">{saved.kind}</span>}
          </div>
        ) : (
          <p className="mb-4 text-sm text-text-3">Artifact saved.</p>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </Card>
    </div>
  );
}

// ── Root panel ────────────────────────────────────────────────────────────────

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, signalPending, stepOutputs, onSignal, onClose, credentials, skills } = props;
  const failed = state?.phase === 'failed';
  const current = activeStep(state);

  function handleConfigSubmit(payload: { variants: VariantConfig[]; input: string }) {
    onSignal(CONFIG_SIGNAL, payload);
  }

  function handleApprove() {
    onSignal(REVIEW_SIGNAL, { approved: true });
  }

  function handleSkip() {
    onSignal(REVIEW_SIGNAL, { approved: false });
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-medium text-text">A/B Compare</h2>
          <p className="text-xs text-text-3">Blind ranking across provider/model variants</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close panel">
          Close
        </Button>
      </header>

      <HorizontalStepper steps={buildStepperSteps(state)} />

      <div className="flex-1 overflow-y-auto p-6">
        {failed ? (
          <div className="rounded-panel border border-orange bg-orange-soft p-4">
            <p className="text-sm text-orange-deep">
              This run failed. Review the run log and try again.
            </p>
          </div>
        ) : current === 'config' ? (
          <ConfigScreen
            phase={phaseFor(state, 'config')}
            connected={connected}
            signalPending={signalPending}
            credentials={credentials}
            skills={skills}
            onSubmit={handleConfigSubmit}
          />
        ) : current === 'execute' ? (
          <ExecuteScreen phase={phaseFor(state, 'execute')} />
        ) : current === 'compare' ? (
          <CompareScreen phase={phaseFor(state, 'compare')} output={stepOutputs['compare']} />
        ) : current === 'review' ? (
          <ReviewScreen
            phase={phaseFor(state, 'review')}
            compareOutput={stepOutputs['compare']}
            executeOutput={stepOutputs['execute']}
            connected={connected}
            signalPending={signalPending}
            onApprove={handleApprove}
            onSkip={handleSkip}
          />
        ) : (
          <PersistScreen
            phase={phaseFor(state, 'persist')}
            output={stepOutputs['persist']}
            configOutput={stepOutputs['config']}
            compareOutput={stepOutputs['compare']}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
