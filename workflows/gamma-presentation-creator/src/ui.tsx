import { useState, type ReactNode } from 'react';
import { type } from 'arktype';
import {
  Button,
  HorizontalStepper,
  Markdown,
  type WorkflowPanelProps,
  type WorkflowStep,
} from '@workbench/ui';
import type { RunState, StepState } from '@intx/workflow';

// ── Step ordering ────────────────────────────────────────────────────────────

// Logical UX steps drive the stepper and `activeStep`. Internal substrate steps
// (list-templates, list-notes, source) are sub-steps within the first two UX
// phases and are not shown separately in the stepper.
const STEP_ORDER = ['template', 'source', 'generate', 'review', 'render'] as const;

type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  template: 'Template',
  source: 'Source',
  generate: 'Generate',
  review: 'Review',
  render: 'Render',
};

type StepPhase = StepState['phase'];

function phaseFor(state: RunState | null, stepId: string): StepPhase | undefined {
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

// Returns the first UX step that is not yet `completed`, or `"render"` when
// all steps are done. This drives the guided "render only the active step" rule.
function activeStep(state: RunState | null): StepKey {
  for (const id of STEP_ORDER) {
    if (phaseFor(state, id) !== 'completed') return id;
  }
  return 'render';
}

// ── Output parsing schemas ────────────────────────────────────────────────────

// `deterministicToolStep` wraps its tool return value in this envelope.
const ToolResultEnvelope = type({ 'callId?': 'string', content: 'string' });

// gamma_list_templates handler returns JSON.stringify([{ gammaId, name, ... }])
const TemplateItem = type({ gammaId: 'string', name: 'string' });
const TemplateArray = TemplateItem.array();

// granola_list_notes handler returns JSON.stringify({ notes: [...], hasMore })
const NoteItem = type({ id: 'string', 'title?': 'string | null' });
const NotesResult = type({ notes: NoteItem.array() });

// granola_get_note handler returns JSON.stringify({ id, title, summary, ... })
const GranolaNote = type({
  'id?': 'string',
  'title?': 'string | null',
  'summary?': 'string',
});

// Agent `step` output shape: { reply: string, turn: unknown }
const AgentStepOutput = type({ reply: 'string', 'turn?': 'unknown' });

// gamma_create_from_template handler returns { gammaUrl, gammaId }
const GammaResult = type({ 'gammaUrl?': 'string', 'url?': 'string' });

// Template awaitSignal payload carrying the user's brief
const TemplateBrief = type({
  'gammaId?': 'string',
  'audience?': 'string',
  'tone?': 'string',
  'goal?': 'string',
});

// ── Parsing helpers ───────────────────────────────────────────────────────────

function peelEnvelope(raw: unknown): unknown {
  const envelope = ToolResultEnvelope(raw);
  if (envelope instanceof type.errors) return undefined;
  try {
    return JSON.parse(envelope.content);
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

type TemplateOption = { gammaId: string; name: string };

function readTemplateOptions(stepOutputs: Record<string, unknown>): TemplateOption[] {
  const inner = peelEnvelope(stepOutputs['list-templates']);
  if (inner === undefined) return [];
  const parsed = TemplateArray(inner);
  if (parsed instanceof type.errors) return [];
  return parsed.map((t) => ({ gammaId: t.gammaId, name: t.name }));
}

type NoteOption = { id: string; title: string };

function readNoteOptions(stepOutputs: Record<string, unknown>): NoteOption[] {
  const inner = peelEnvelope(stepOutputs['list-notes']);
  if (inner === undefined) return [];
  const parsed = NotesResult(inner);
  if (parsed instanceof type.errors) return [];
  return parsed.notes.map((n) => ({
    id: n.id,
    title: readString(n.title) ?? n.id,
  }));
}

type GenerateResult =
  | { kind: 'ready'; reply: string }
  | { kind: 'loading' }
  | { kind: 'malformed' };

function readGenerate(output: unknown, generatePhase: StepPhase | undefined): GenerateResult {
  if (generatePhase !== 'completed') return { kind: 'loading' };
  const parsed = AgentStepOutput(output);
  if (parsed instanceof type.errors) return { kind: 'malformed' };
  return { kind: 'ready', reply: parsed.reply };
}

function readSourceTitle(stepOutputs: Record<string, unknown>): string | undefined {
  const inner = peelEnvelope(stepOutputs['source']);
  if (inner === undefined) return undefined;
  const parsed = GranolaNote(inner);
  if (parsed instanceof type.errors) return undefined;
  return readString(parsed.title);
}

function isSafePresentationURL(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function readGammaURL(stepOutputs: Record<string, unknown>): string | undefined {
  const inner = peelEnvelope(stepOutputs['render']);
  if (inner === undefined) return undefined;
  const parsed = GammaResult(inner);
  if (parsed instanceof type.errors) return undefined;
  return readString(parsed.gammaUrl) ?? readString(parsed.url);
}

function briefRows(stepOutputs: Record<string, unknown>): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];

  const template = TemplateBrief(stepOutputs['template']);
  if (!(template instanceof type.errors)) {
    const templateId = readString(template.gammaId);
    if (templateId !== undefined) rows.push({ label: 'Template', value: templateId });
    const audience = readString(template.audience);
    if (audience !== undefined) rows.push({ label: 'Audience', value: audience });
    const tone = readString(template.tone);
    if (tone !== undefined) rows.push({ label: 'Tone', value: tone });
    const goal = readString(template.goal);
    if (goal !== undefined) rows.push({ label: 'Goal', value: goal });
  }

  const sourceTitle = readSourceTitle(stepOutputs);
  if (sourceTitle !== undefined) rows.push({ label: 'Source', value: sourceTitle });

  return rows;
}

// ── Shared layout ─────────────────────────────────────────────────────────────

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

// ── Step screens ──────────────────────────────────────────────────────────────

function TemplateScreen({
  phase,
  connected,
  signalPending,
  stepOutputs,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  stepOutputs: Record<string, unknown>;
  onSubmit: (payload: {
    gammaId: string;
    templateId: string;
    audience: string;
    tone: string;
    goal: string;
  }) => void;
}) {
  const templates = readTemplateOptions(stepOutputs);
  const [gammaId, setGammaId] = useState(templates[0]?.gammaId ?? '');
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState('');
  const [goal, setGoal] = useState('');
  const canSubmit =
    connected && !signalPending && gammaId.trim().length > 0 && goal.trim().length > 0;

  if (phase !== 'awaiting-signal') {
    return <LoadingState label="Loading templates…" />;
  }

  const fieldClass =
    'w-full rounded-[8px] border border-border bg-surface px-3 py-2 text-[13px] text-text';

  return (
    <Card>
      <CardTitle>Set up the deck</CardTitle>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          onSubmit({
            gammaId: gammaId.trim(),
            templateId: gammaId.trim(),
            audience: audience.trim(),
            tone: tone.trim(),
            goal: goal.trim(),
          });
        }}
      >
        <label className="block space-y-1">
          <span className="text-[12px] text-text-3">Template</span>
          {templates.length > 0 ? (
            <select
              aria-label="Template"
              value={gammaId}
              onChange={(e) => setGammaId(e.target.value)}
              className={fieldClass}
            >
              {templates.map((t) => (
                <option key={t.gammaId} value={t.gammaId}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label="Template"
              value={gammaId}
              onChange={(e) => setGammaId(e.target.value)}
              placeholder="Template gammaId"
              className={fieldClass}
            />
          )}
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-text-3">Audience</span>
          <input
            aria-label="Audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-text-3">Tone</span>
          <input
            aria-label="Tone"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-text-3">Goal</span>
          <input
            aria-label="Goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            className={fieldClass}
          />
        </label>
        <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
          Continue
        </Button>
        {!connected && <p className="text-xs text-text-3">Reconnecting — input unavailable.</p>}
      </form>
    </Card>
  );
}

function SourceScreen({
  phase,
  signalPending,
  stepOutputs,
  onSelect,
}: {
  phase: StepPhase | undefined;
  signalPending: boolean;
  stepOutputs: Record<string, unknown>;
  onSelect: (noteId: string) => void;
}) {
  const notes = readNoteOptions(stepOutputs);

  if (phase !== 'awaiting-signal') {
    return <LoadingState label="Loading calls…" />;
  }

  return (
    <Card>
      <CardTitle>Choose a call</CardTitle>
      {notes.length === 0 ? (
        <p className="text-sm text-text-3">No Granola calls available.</p>
      ) : (
        <ul className="divide-y divide-border rounded-[10px] border border-border bg-surface">
          {notes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                disabled={signalPending}
                onClick={() => onSelect(n.id)}
                className="block w-full px-3 py-2 text-left text-[13px] text-text transition-colors enabled:hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {n.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GenerateScreen({ phase }: { phase: StepPhase | undefined }) {
  if (phase === 'in-flight' || phase === undefined) {
    return <LoadingState label="Drafting the presentation content…" />;
  }
  return <LoadingState label="Drafting complete — preparing review…" />;
}

function ReviewScreen({
  phase,
  stepOutputs,
  draftPhase,
  connected,
  signalPending,
  onApprove,
}: {
  phase: StepPhase | undefined;
  stepOutputs: Record<string, unknown>;
  draftPhase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  onApprove: () => void;
}) {
  const generate = readGenerate(stepOutputs['brand-review'] ?? stepOutputs['generate'], draftPhase);
  const rows = briefRows(stepOutputs);

  return (
    <div className="space-y-4">
      {rows.length > 0 && (
        <Card>
          <CardTitle>Brief</CardTitle>
          <dl className="divide-y divide-border">
            {rows.map((row) => (
              <div key={row.label} className="flex gap-3 px-3 py-2">
                <dt className="w-24 shrink-0 text-[12px] text-text-3">{row.label}</dt>
                <dd className="break-words text-[12px] text-text">{row.value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      {generate.kind === 'ready' && (
        <Card>
          <CardTitle>Draft content</CardTitle>
          <Markdown>{generate.reply}</Markdown>
        </Card>
      )}

      {generate.kind === 'malformed' && (
        <Card>
          <p className="text-sm text-orange">Couldn't read the draft outline.</p>
          <p className="mt-1 text-xs text-text-3">
            The generate step finished but its result was malformed.
          </p>
        </Card>
      )}

      <Card>
        <CardTitle>Review the draft</CardTitle>
        <p className="mb-4 text-sm text-text-2">
          Approve the generated content to render the deck in Gamma.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            disabled={!connected || signalPending || phase !== 'awaiting-signal'}
            onClick={onApprove}
          >
            Approve
          </Button>
          {!connected && (
            <p className="text-xs text-text-3">Reconnecting — approval unavailable.</p>
          )}
        </div>
      </Card>
    </div>
  );
}

function RenderScreen({
  phase,
  stepOutputs,
  onClose,
}: {
  phase: StepPhase | undefined;
  stepOutputs: Record<string, unknown>;
  onClose: () => void;
}) {
  if (phase === 'in-flight' || phase === undefined) {
    return <LoadingState label="Rendering the deck in Gamma…" />;
  }

  const gammaURL = readGammaURL(stepOutputs);

  if (!isSafePresentationURL(gammaURL)) {
    if (phase === 'completed') {
      return (
        <Card>
          <p className="text-sm text-orange">Presentation URL is invalid or unavailable.</p>
        </Card>
      );
    }
    return <LoadingState label="Rendering the deck in Gamma…" />;
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
        <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
          <iframe
            src={gammaURL}
            allow="fullscreen"
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
            className="absolute inset-0 h-full w-full border-0"
            title="Generated Gamma presentation"
          />
        </div>
      </div>
      <div className="flex gap-3">
        <a
          href={gammaURL}
          target="_blank"
          rel="noreferrer"
          className="btn-primary block flex-1 text-center"
        >
          Open in Gamma
        </a>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

// ── Root panel ────────────────────────────────────────────────────────────────

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, signalPending, stepOutputs, onSignal, onClose } = props;
  const failed = state?.phase === 'failed';
  const current = activeStep(state);

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-medium text-text">Gamma Presentation</h2>
          <p className="text-xs text-text-3">Build a Gamma deck from a Granola call</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close panel">
          Close
        </Button>
      </header>

      <HorizontalStepper steps={buildStepperSteps(state)} />

      <div className="flex-1 overflow-y-auto p-6">
        {failed ? (
          <Card>
            <p className="text-sm font-medium text-text">Generation failed</p>
            <p className="mt-1 text-sm text-text-3">
              The deck could not be generated. Start a new run to try again.
            </p>
          </Card>
        ) : current === 'template' ? (
          <TemplateScreen
            phase={phaseFor(state, 'template')}
            connected={connected}
            signalPending={signalPending}
            stepOutputs={stepOutputs}
            onSubmit={(payload) => onSignal('template', payload)}
          />
        ) : current === 'source' ? (
          <SourceScreen
            phase={phaseFor(state, 'source-selection')}
            signalPending={signalPending}
            stepOutputs={stepOutputs}
            onSelect={(noteId) => onSignal('source-selection', { noteId })}
          />
        ) : current === 'generate' ? (
          <GenerateScreen phase={phaseFor(state, 'generate')} />
        ) : current === 'review' ? (
          <ReviewScreen
            phase={phaseFor(state, 'review')}
            stepOutputs={stepOutputs}
            draftPhase={phaseFor(state, 'brand-review') ?? phaseFor(state, 'generate')}
            connected={connected}
            signalPending={signalPending}
            onApprove={() => onSignal('review-approval', { approved: true })}
          />
        ) : (
          <RenderScreen
            phase={phaseFor(state, 'render')}
            stepOutputs={stepOutputs}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
