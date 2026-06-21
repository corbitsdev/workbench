import { useState } from 'react';
import { type } from 'arktype';
import {
  Button,
  HorizontalStepper,
  type WorkflowPanelProps,
  type WorkflowStep,
} from '@workbench/ui';
import type { RunState } from '@intx/workflow';

// -------------------------------------------------------------------------
// Step configuration
// -------------------------------------------------------------------------

const STEP_CONFIG = [
  { id: 'intake', label: 'Transcript' },
  { id: 'context', label: 'Context' },
  { id: 'analyze', label: 'Pain Points' },
  { id: 'generate', label: 'Generate' },
  { id: 'review', label: 'Review' },
  { id: 'persist', label: 'Done' },
] as const;

type StepPhase = NonNullable<ReturnType<RunState['steps']['get']>>['phase'];

// -------------------------------------------------------------------------
// Arktype schemas — parse every untrusted stepOutput
// -------------------------------------------------------------------------

const ToolResultEnvelope = type({ content: 'string' });

const GranolaNote = type({
  id: 'string',
  'title?': 'string | null',
  'created_at?': 'string',
  'summary?': 'string',
});
type GranolaNote = typeof GranolaNote.infer;

const GranolaListContent = type({ notes: GranolaNote.array() });

const GranolaNoteDetail = type({
  'id?': 'string',
  'title?': 'string | null',
  'summary?': 'string',
  'transcript?': 'string',
});

const PainPoint = type({
  id: 'string',
  title: 'string',
  detail: 'string',
});
type PainPoint = typeof PainPoint.infer;

const AnalyzeOutput = type({ painPoints: PainPoint.array() });

const GeneratedPiece = type({
  format: 'string',
  title: 'string',
  content: 'string',
});
type GeneratedPiece = typeof GeneratedPiece.infer;

const AgentReplyEnvelope = type({ reply: 'string' });

const ReviewDecision = type({
  format: 'string',
  title: 'string',
  content: 'string',
});

const PersistOutput = type({ decisions: ReviewDecision.array() });

// -------------------------------------------------------------------------
// Output parsing helpers
// -------------------------------------------------------------------------

type Decoded<T> = { status: 'pending' } | { status: 'malformed' } | { status: 'ok'; value: T };

function decodeToolEnvelope(
  raw: unknown
): { status: 'pending' } | { status: 'malformed' } | { status: 'ok'; value: unknown } {
  const envelope = ToolResultEnvelope(raw);
  if (envelope instanceof type.errors) return { status: 'pending' };
  try {
    return { status: 'ok', value: JSON.parse(envelope.content) };
  } catch {
    return { status: 'malformed' };
  }
}

function parseNoteList(raw: unknown): Decoded<GranolaNote[]> {
  const decoded = decodeToolEnvelope(raw);
  if (decoded.status !== 'ok') return decoded;
  const parsed = GranolaListContent(decoded.value);
  if (parsed instanceof type.errors) return { status: 'malformed' };
  return { status: 'ok', value: parsed.notes };
}

function parseFetchedNote(raw: unknown): Decoded<typeof GranolaNoteDetail.infer> {
  const decoded = decodeToolEnvelope(raw);
  if (decoded.status !== 'ok') return decoded;
  const parsed = GranolaNoteDetail(decoded.value);
  if (parsed instanceof type.errors) return { status: 'malformed' };
  return { status: 'ok', value: parsed };
}

function parseAnalyze(raw: unknown): Decoded<PainPoint[]> {
  // Agent step: output is { reply: string } — parse JSON from reply
  const envelope = AgentReplyEnvelope(raw);
  if (envelope instanceof type.errors) return { status: 'pending' };
  if (envelope.reply.trim() === '') return { status: 'pending' };
  try {
    const inner = JSON.parse(envelope.reply);
    const parsed = AnalyzeOutput(inner);
    if (parsed instanceof type.errors) return { status: 'malformed' };
    return { status: 'ok', value: parsed.painPoints };
  } catch {
    return { status: 'malformed' };
  }
}

function parseGeneratedPieces(raw: unknown): Decoded<GeneratedPiece[]> {
  // map step output is an array of agent step outputs: Array<{reply: string}>
  if (!Array.isArray(raw)) return { status: 'pending' };
  const pieces: GeneratedPiece[] = [];
  for (const item of raw) {
    const envelope = AgentReplyEnvelope(item);
    if (envelope instanceof type.errors) return { status: 'malformed' };
    try {
      const inner = JSON.parse(envelope.reply);
      const parsed = GeneratedPiece(inner);
      if (parsed instanceof type.errors) return { status: 'malformed' };
      pieces.push(parsed);
    } catch {
      return { status: 'malformed' };
    }
  }
  return { status: 'ok', value: pieces };
}

function parsePersistOutput(raw: unknown): Decoded<typeof PersistOutput.infer> {
  const parsed = PersistOutput(raw);
  if (parsed instanceof type.errors) return { status: 'pending' };
  return { status: 'ok', value: parsed };
}

// -------------------------------------------------------------------------
// Phase / stepper helpers
// -------------------------------------------------------------------------

// All internal workflow step IDs — used by hasFailed to cover non-display steps
const ALL_STEP_IDS = [
  'intake',
  'select',
  'fetch',
  'context',
  'analyze',
  'ppSelection',
  'fmtSelection',
  'generate',
  'review',
  'persist',
] as const;

function phaseFor(state: RunState | null, id: string): StepPhase | undefined {
  return state?.steps.get(id)?.phase;
}

function isActive(state: RunState | null, id: string): boolean {
  const phase = phaseFor(state, id);
  return phase === 'in-flight' || phase === 'awaiting-signal' || phase === 'awaiting-timer';
}

/**
 * Returns the display-step index (0-based) that should be highlighted as
 * "current" in the stepper. Maps internal workflow step clusters to their
 * corresponding STEP_CONFIG display position.
 *
 * Cluster → display index:
 *   0 — Transcript: intake, select, fetch
 *   1 — Context:    context
 *   2 — Pain Points: analyze, ppSelection
 *   3 — Generate:   fmtSelection (format picker only — while awaiting the signal)
 *   4 — Review:     generate (running/completed), review (signal)
 *   5 — Done:       persist
 *
 * Note: fmtSelection is in display group 3 only while it is awaiting-signal.
 * Once the signal fires and generate starts, we advance to group 4 so the
 * review panel shows the "generating" state rather than the completed format
 * picker screen.
 */
function activeDisplayIndex(state: RunState | null): number {
  if (isActive(state, 'intake') || isActive(state, 'select') || isActive(state, 'fetch')) return 0;
  if (isActive(state, 'context')) return 1;
  if (isActive(state, 'analyze') || isActive(state, 'ppSelection')) return 2;
  if (isActive(state, 'fmtSelection')) return 3;
  // generate running or review awaiting — show the review/collateral panel
  if (isActive(state, 'generate') || isActive(state, 'review')) return 4;
  if (isActive(state, 'persist')) return 5;
  // Fall through: derive from first non-completed display step
  const displayGroups = [
    ['intake', 'select', 'fetch'],
    ['context'],
    ['analyze', 'ppSelection'],
    ['fmtSelection'],
    ['generate', 'review'],
    ['persist'],
  ] as const;
  for (let i = 0; i < displayGroups.length; i += 1) {
    const anyIncomplete = displayGroups[i]!.some((id) => phaseFor(state, id) !== 'completed');
    if (anyIncomplete) return i;
  }
  return 5;
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  const activeIdx = activeDisplayIndex(state);
  return STEP_CONFIG.map(({ label }, index) => {
    let status: WorkflowStep['status'];
    if (index < activeIdx) {
      status = 'completed';
    } else if (index === activeIdx) {
      status = 'current';
    } else {
      status = 'pending';
    }
    return { number: index + 1, label, status };
  });
}

function hasFailed(state: RunState | null): boolean {
  if (!state) return false;
  if (state.phase === 'failed') return true;
  for (const id of ALL_STEP_IDS) {
    if (phaseFor(state, id) === 'failed') return true;
  }
  return false;
}

/**
 * Determine which "display group" is currently active. This drives which
 * SectionCard is rendered in the Panel body.
 */
type DisplayGroup = 'transcript' | 'context' | 'painPoints' | 'formats' | 'review' | 'done';

function activeDisplayGroup(state: RunState | null): DisplayGroup {
  const idx = activeDisplayIndex(state);
  const groups: DisplayGroup[] = [
    'transcript',
    'context',
    'painPoints',
    'formats',
    'review',
    'done',
  ];
  return groups[idx] ?? 'done';
}

// -------------------------------------------------------------------------
// Reusable sub-components
// -------------------------------------------------------------------------

const fieldClass =
  'w-full rounded-[8px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange';

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-border bg-surface p-4">
      <h3 className="mb-3 text-[13px] font-semibold text-text">{title}</h3>
      {children}
    </section>
  );
}

function Placeholder({ label }: { label: string }) {
  return <p className="text-[13px] text-text-3">{label}</p>;
}

function ErrorLine({ label }: { label: string }) {
  return <p className="text-[13px] text-orange">{label}</p>;
}

// -------------------------------------------------------------------------
// Step 1 — Transcript selection
// -------------------------------------------------------------------------

function TranscriptStep({
  stepOutputs,
  intakePhase,
  selectPhase,
  onSelect,
}: {
  stepOutputs: Record<string, unknown>;
  intakePhase: StepPhase | undefined;
  selectPhase: StepPhase | undefined;
  onSelect: (noteId: string) => void;
}) {
  const result = parseNoteList(stepOutputs.intake);

  if (result.status === 'pending') {
    if (intakePhase === 'completed')
      return <ErrorLine label="Couldn't read the Granola note list." />;
    return <Placeholder label="Loading your Granola notes…" />;
  }
  if (result.status === 'malformed')
    return <ErrorLine label="Couldn't read the Granola note list." />;
  if (result.value.length === 0) return <Placeholder label="No Granola notes were found." />;

  const selectable = selectPhase === 'awaiting-signal' || selectPhase === 'in-flight';
  if (selectPhase === 'completed') {
    return <Placeholder label="Note selected. Fetching the transcript…" />;
  }

  return (
    <ul className="space-y-2">
      {result.value.map((note) => (
        <li key={note.id}>
          <button
            type="button"
            disabled={!selectable}
            onClick={() => onSelect(note.id)}
            className="w-full rounded-[8px] border border-border bg-bg px-3 py-2.5 text-left text-[13px] text-text-2 enabled:hover:border-orange disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
          >
            <span className="block font-medium text-text">{note.title ?? 'Untitled note'}</span>
            {note.summary ? <span className="mt-0.5 block text-text-3">{note.summary}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

// -------------------------------------------------------------------------
// Step 2 — Context input
// -------------------------------------------------------------------------

function ContextStep({
  stepOutputs,
  contextPhase,
  fetchPhase,
  onSubmit,
}: {
  stepOutputs: Record<string, unknown>;
  contextPhase: StepPhase | undefined;
  fetchPhase: StepPhase | undefined;
  onSubmit: (context: string) => void;
}) {
  const [value, setValue] = useState('');

  if (contextPhase === 'completed') {
    return <Placeholder label="Context saved. Analyzing pain points…" />;
  }

  const awaiting = contextPhase === 'awaiting-signal' || contextPhase === 'in-flight';

  const fetchResult = parseFetchedNote(stepOutputs.fetch);
  const noteTitle =
    fetchResult.status === 'ok' ? (fetchResult.value.title ?? undefined) : undefined;

  return (
    <div className="space-y-3">
      {noteTitle ? (
        <p className="text-[12px] text-text-3">
          Transcript: <span className="font-medium text-text-2">{noteTitle}</span>
        </p>
      ) : fetchPhase === 'in-flight' ? (
        <Placeholder label="Fetching transcript…" />
      ) : null}

      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium text-text-2">
          Add any specific notes or context
        </span>
        <textarea
          rows={4}
          disabled={!awaiting}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. focus on integration issues, prospect is a Series B startup…"
          className={`${fieldClass} resize-none disabled:opacity-60`}
        />
      </label>

      <Button
        variant="primary"
        size="sm"
        disabled={!awaiting}
        onClick={() => {
          if (!awaiting) return;
          onSubmit(value.trim());
        }}
      >
        Continue
      </Button>
    </div>
  );
}

// -------------------------------------------------------------------------
// Step 3 — Pain point selection
// -------------------------------------------------------------------------

function PainPointStep({
  stepOutputs,
  analyzePhase,
  ppSelectionPhase,
  onSubmit,
}: {
  stepOutputs: Record<string, unknown>;
  analyzePhase: StepPhase | undefined;
  ppSelectionPhase: StepPhase | undefined;
  onSubmit: (selectedIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (ppSelectionPhase === 'completed') {
    return <Placeholder label="Pain points selected. Choose output formats…" />;
  }

  const result = parseAnalyze(stepOutputs.analyze);

  if (result.status === 'pending') {
    if (analyzePhase === 'completed')
      return <ErrorLine label="Couldn't read the extracted pain points." />;
    return <Placeholder label="Analyzing transcript for pain points…" />;
  }
  if (result.status === 'malformed')
    return <ErrorLine label="Couldn't read the extracted pain points." />;

  const awaiting = ppSelectionPhase === 'awaiting-signal' || ppSelectionPhase === 'in-flight';

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-text-3">
        Select the pain points you want to address in collateral.
      </p>
      <ul className="space-y-2">
        {result.value.map((pp) => {
          const checked = selected.has(pp.id);
          return (
            <li key={pp.id}>
              <label className="flex cursor-pointer items-start gap-3 rounded-[8px] border border-border bg-bg px-3 py-2.5 transition-colors hover:border-orange has-[:checked]:border-orange has-[:checked]:bg-orange/5">
                <input
                  type="checkbox"
                  disabled={!awaiting}
                  checked={checked}
                  onChange={() => toggle(pp.id)}
                  className="mt-0.5 h-4 w-4 accent-orange disabled:cursor-not-allowed"
                />
                <div>
                  <p className="text-[13px] font-medium text-text">{pp.title}</p>
                  <p className="mt-0.5 text-[12px] text-text-3">{pp.detail}</p>
                </div>
              </label>
            </li>
          );
        })}
      </ul>

      <Button
        variant="primary"
        size="sm"
        disabled={!awaiting || selected.size === 0}
        onClick={() => {
          if (!awaiting) return;
          onSubmit([...selected]);
        }}
      >
        Select{' '}
        {selected.size > 0
          ? `${selected.size} pain point${selected.size === 1 ? '' : 's'}`
          : 'pain points'}
      </Button>
    </div>
  );
}

// -------------------------------------------------------------------------
// Step 4 — Format selection
// -------------------------------------------------------------------------

const COLLATERAL_FORMATS = [
  'Email',
  'One-pager',
  'LinkedIn post',
  'Cold outreach',
  'Case study snippet',
  'Executive summary',
] as const;

function FormatStep({
  fmtSelectionPhase,
  onSubmit,
}: {
  fmtSelectionPhase: StepPhase | undefined;
  onSubmit: (formats: Array<{ format: string }>) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (fmtSelectionPhase === 'completed') {
    return <Placeholder label="Formats selected. Generating collateral…" />;
  }

  const awaiting = fmtSelectionPhase === 'awaiting-signal' || fmtSelectionPhase === 'in-flight';

  function toggle(fmt: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fmt)) {
        next.delete(fmt);
      } else {
        next.add(fmt);
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-text-3">Choose the collateral formats to generate.</p>
      <ul className="space-y-2">
        {COLLATERAL_FORMATS.map((fmt) => {
          const checked = selected.has(fmt);
          return (
            <li key={fmt}>
              <label className="flex cursor-pointer items-center gap-3 rounded-[8px] border border-border bg-bg px-3 py-2.5 transition-colors hover:border-orange has-[:checked]:border-orange has-[:checked]:bg-orange/5">
                <input
                  type="checkbox"
                  disabled={!awaiting}
                  checked={checked}
                  onChange={() => toggle(fmt)}
                  className="h-4 w-4 accent-orange disabled:cursor-not-allowed"
                />
                <span className="text-[13px] font-medium text-text">{fmt}</span>
              </label>
            </li>
          );
        })}
      </ul>

      <Button
        variant="primary"
        size="sm"
        disabled={!awaiting || selected.size === 0}
        onClick={() => {
          if (!awaiting) return;
          onSubmit([...selected].map((format) => ({ format })));
        }}
      >
        Generate{' '}
        {selected.size > 0
          ? `${selected.size} format${selected.size === 1 ? '' : 's'}`
          : 'collateral'}
      </Button>
    </div>
  );
}

// -------------------------------------------------------------------------
// Step 5 — Review generated pieces (Tinder-style approve / deny)
// -------------------------------------------------------------------------

type Decision = { piece: GeneratedPiece; approved: boolean };

function ReviewStep({
  stepOutputs,
  generatePhase,
  reviewPhase,
  onSubmit,
}: {
  stepOutputs: Record<string, unknown>;
  generatePhase: StepPhase | undefined;
  reviewPhase: StepPhase | undefined;
  onSubmit: (approved: GeneratedPiece[]) => void;
}) {
  const result = parseGeneratedPieces(stepOutputs.generate);
  const [decisions, setDecisions] = useState<Decision[]>(() =>
    result.status === 'ok' ? result.value.map((piece) => ({ piece, approved: true })) : []
  );

  if (reviewPhase === 'completed') {
    return <Placeholder label="Review complete. Creating artifacts…" />;
  }

  if (result.status === 'pending') {
    if (generatePhase === 'completed')
      return <ErrorLine label="Couldn't read the generated collateral." />;
    return <Placeholder label="Generating collateral…" />;
  }
  if (result.status === 'malformed')
    return <ErrorLine label="Couldn't read the generated collateral." />;

  // Sync decisions when generate output arrives
  const pieces = result.value;
  const synced =
    decisions.length === pieces.length &&
    decisions.every((d, i) => d.piece.format === pieces[i]?.format);
  const activeDec = synced ? decisions : pieces.map((piece) => ({ piece, approved: true }));

  const awaiting = reviewPhase === 'awaiting-signal' || reviewPhase === 'in-flight';

  function setApproved(index: number, approved: boolean) {
    setDecisions((prev) => {
      const next = synced
        ? [...prev]
        : pieces.map((p, i) => ({ piece: p, approved: prev[i]?.approved ?? true }));
      return next.map((d, i) => (i === index ? { ...d, approved } : d));
    });
  }

  const approvedPieces = activeDec.filter((d) => d.approved).map((d) => d.piece);

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-text-3">
        Approve the pieces you want to save as artifacts. Denied pieces are discarded.
      </p>

      {activeDec.map((dec, index) => (
        <div
          key={dec.piece.format}
          className={`rounded-[10px] border bg-surface p-4 transition-colors ${
            dec.approved ? 'border-green/60' : 'border-border opacity-60'
          }`}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <span className="rounded-[5px] bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-3">
                {dec.piece.format}
              </span>
              <p className="mt-1 text-[13px] font-semibold text-text">{dec.piece.title}</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!awaiting}
                aria-label={`Approve ${dec.piece.format}`}
                onClick={() => setApproved(index, true)}
                className={`rounded-[7px] border px-3 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ${
                  dec.approved
                    ? 'border-green/60 bg-green/10 text-green'
                    : 'border-border bg-bg text-text-3 hover:border-green/60 hover:text-green'
                }`}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={!awaiting}
                aria-label={`Deny ${dec.piece.format}`}
                onClick={() => setApproved(index, false)}
                className={`rounded-[7px] border px-3 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ${
                  !dec.approved
                    ? 'border-orange/60 bg-orange/10 text-orange'
                    : 'border-border bg-bg text-text-3 hover:border-orange/60 hover:text-orange'
                }`}
              >
                Deny
              </button>
            </div>
          </div>
          <pre className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text-2">
            {dec.piece.content}
          </pre>
        </div>
      ))}

      <Button
        variant="primary"
        size="sm"
        disabled={!awaiting || approvedPieces.length === 0}
        onClick={() => {
          if (!awaiting) return;
          onSubmit(approvedPieces);
        }}
      >
        Save {approvedPieces.length} artifact{approvedPieces.length === 1 ? '' : 's'}
      </Button>
    </div>
  );
}

// -------------------------------------------------------------------------
// Step 6 — Done / artifact list
// -------------------------------------------------------------------------

function DoneStep({
  stepOutputs,
  persistPhase,
  onClose,
}: {
  stepOutputs: Record<string, unknown>;
  persistPhase: StepPhase | undefined;
  onClose: () => void;
}) {
  if (persistPhase !== 'completed') {
    return <Placeholder label="Creating artifacts…" />;
  }

  const result = parsePersistOutput(stepOutputs.review);
  const decisions = result.status === 'ok' ? result.value.decisions : [];

  return (
    <div className="space-y-4">
      <p className="text-[13px] font-medium text-text">
        {decisions.length > 0 ? 'Artifacts created successfully.' : 'Run complete.'}
      </p>
      {decisions.length > 0 && (
        <ul className="space-y-1.5">
          {decisions.map((d) => (
            <li
              key={d.format}
              className="flex items-center gap-2 rounded-[7px] border border-border bg-surface px-3 py-2 text-[13px] text-text"
            >
              <span className="rounded-[5px] bg-surface-2 px-2 py-0.5 text-[11px] text-text-3">
                {d.format}
              </span>
              <span className="truncate">{d.title}</span>
            </li>
          ))}
        </ul>
      )}
      <Button variant="secondary" size="sm" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

// -------------------------------------------------------------------------
// Panel
// -------------------------------------------------------------------------

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, stepOutputs, onSignal, onClose } = props;

  const group = activeDisplayGroup(state);
  const failed = hasFailed(state);
  const stepperSteps = buildStepperSteps(state);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">Collateral Generation</p>
          <p className="mt-px text-[11px] text-text-3">{connected ? 'Live' : 'Reconnecting…'}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] border border-border text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
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
      </header>

      <HorizontalStepper steps={stepperSteps} />

      {/* Body — renders ONLY the active display group */}
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {failed && (
          <div className="rounded-[10px] border border-orange/40 bg-orange/5 px-4 py-3">
            <p className="text-[13px] font-medium text-orange">This run failed.</p>
            <p className="mt-1 text-[12px] text-text-3">
              Review the step details and start a new run.
            </p>
          </div>
        )}

        {/* Group 0 — Transcript: intake → select (note-selection signal) → fetch */}
        {group === 'transcript' && (
          <SectionCard title="Select a Granola transcript">
            <TranscriptStep
              stepOutputs={stepOutputs}
              intakePhase={phaseFor(state, 'intake')}
              selectPhase={phaseFor(state, 'select')}
              onSelect={(noteId) => onSignal('note-selection', { noteId })}
            />
          </SectionCard>
        )}

        {/* Group 1 — Context: context signal */}
        {group === 'context' && (
          <SectionCard title="Add context">
            <ContextStep
              stepOutputs={stepOutputs}
              contextPhase={phaseFor(state, 'context')}
              fetchPhase={phaseFor(state, 'fetch')}
              onSubmit={(context) => onSignal('context', { context })}
            />
          </SectionCard>
        )}

        {/* Group 2 — Pain Points: analyze → ppSelection signal */}
        {group === 'painPoints' && (
          <SectionCard title="Select pain points">
            <PainPointStep
              stepOutputs={stepOutputs}
              analyzePhase={phaseFor(state, 'analyze')}
              ppSelectionPhase={phaseFor(state, 'ppSelection')}
              onSubmit={(selectedIds) => onSignal('pain-point-selection', { selectedIds })}
            />
          </SectionCard>
        )}

        {/* Group 3 — Generate: fmtSelection signal → generate map */}
        {group === 'formats' && (
          <SectionCard title="Choose formats">
            <FormatStep
              fmtSelectionPhase={phaseFor(state, 'fmtSelection')}
              onSubmit={(formats) => onSignal('format-selection', { formats })}
            />
          </SectionCard>
        )}

        {/* Group 4 — Review: review signal (show generated pieces above) */}
        {group === 'review' && (
          <SectionCard title="Review collateral">
            <ReviewStep
              stepOutputs={stepOutputs}
              generatePhase={phaseFor(state, 'generate')}
              reviewPhase={phaseFor(state, 'review')}
              onSubmit={(approved) =>
                onSignal('review', {
                  decisions: approved.map(({ format, title, content }) => ({
                    format,
                    title,
                    content,
                  })),
                })
              }
            />
          </SectionCard>
        )}

        {/* Group 5 — Done: persist map has run */}
        {group === 'done' && (
          <SectionCard title="Done">
            <DoneStep
              stepOutputs={stepOutputs}
              persistPhase={phaseFor(state, 'persist')}
              onClose={onClose}
            />
          </SectionCard>
        )}
      </div>
    </div>
  );
}
