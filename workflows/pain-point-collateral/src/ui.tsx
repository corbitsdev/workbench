import { useEffect, useMemo, useState } from 'react';
import { type } from 'arktype';
import {
  Button,
  HorizontalStepper,
  Markdown,
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
  'severity?': "'low' | 'medium' | 'high' | 'critical'",
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
  approved: 'boolean',
});

const ApprovedPiece = type({
  format: 'string',
  title: 'string',
  content: 'string',
});

const PersistOutput = type({
  decisions: ReviewDecision.array(),
  'approvedPieces?': ApprovedPiece.array(),
});

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

function stripCodeFence(text: string): string {
  const fenced = text.match(/^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1\s*$/);
  return fenced?.[2]?.trim() ?? text;
}

function extractFirstJsonValue(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseAgentJson(
  reply: string
): { status: 'pending' } | { status: 'malformed' } | { status: 'ok'; value: unknown } {
  const trimmed = reply.trim();
  if (trimmed === '') return { status: 'pending' };

  const unfenced = stripCodeFence(trimmed);
  const jsonText = extractFirstJsonValue(unfenced) ?? unfenced;

  try {
    return { status: 'ok', value: JSON.parse(jsonText) };
  } catch {
    return { status: 'malformed' };
  }
}

function parseAnalyze(raw: unknown): Decoded<PainPoint[]> {
  // Agent step: output is { reply: string } — parse JSON from reply
  const envelope = AgentReplyEnvelope(raw);
  if (envelope instanceof type.errors) return { status: 'pending' };
  const decoded = parseAgentJson(envelope.reply);
  if (decoded.status !== 'ok') return decoded;
  const parsed = AnalyzeOutput(decoded.value);
  if (parsed instanceof type.errors) return { status: 'malformed' };
  return { status: 'ok', value: parsed.painPoints };
}

function parseGeneratedPieces(raw: unknown): Decoded<GeneratedPiece[]> {
  // map step output is an array of agent step outputs: Array<{reply: string}>
  if (!Array.isArray(raw)) return { status: 'pending' };
  const pieces: GeneratedPiece[] = [];
  for (const item of raw) {
    const envelope = AgentReplyEnvelope(item);
    if (envelope instanceof type.errors) return { status: 'malformed' };
    const decoded = parseAgentJson(envelope.reply);
    if (decoded.status !== 'ok') return { status: 'malformed' };
    const parsed = GeneratedPiece(decoded.value);
    if (parsed instanceof type.errors) return { status: 'malformed' };
    pieces.push(parsed);
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
    <section className="rounded-[14px] border border-border bg-surface p-4 shadow-sm">
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

function severityLabel(severity: PainPoint['severity']): string {
  if (severity === 'critical') return 'Critical';
  if (severity === 'high') return 'High';
  if (severity === 'medium') return 'Medium';
  return 'Low';
}

function severityClass(severity: PainPoint['severity']): string {
  if (severity === 'critical') return 'border-red-500/50 bg-red-500/10 text-red-300';
  if (severity === 'high') return 'border-orange/50 bg-orange/10 text-orange';
  if (severity === 'medium') return 'border-yellow-500/50 bg-yellow-500/10 text-yellow-300';
  return 'border-green/40 bg-green/10 text-green';
}

function decisionStatus(decision: Decision): string {
  if (decision.approved === true) return 'Approved';
  if (decision.approved === false) return 'Denied';
  return 'Pending';
}

function decisionBadgeClass(approved: boolean | null): string {
  if (approved === true) return 'bg-green/10 text-green';
  if (approved === false) return 'bg-orange/10 text-orange';
  return 'bg-surface-2 text-text-3';
}

// -------------------------------------------------------------------------
// Step 1 — Transcript selection
// -------------------------------------------------------------------------

function TranscriptStep({
  stepOutputs,
  intakePhase,
  selectPhase,
  signalPending,
  onSelect,
}: {
  stepOutputs: Record<string, unknown>;
  intakePhase: StepPhase | undefined;
  selectPhase: StepPhase | undefined;
  signalPending: boolean;
  onSelect: (noteId: string) => void;
}) {
  const [pendingNoteId, setPendingNoteId] = useState<string | null>(null);
  const result = parseNoteList(stepOutputs.intake);

  if (result.status === 'pending') {
    if (intakePhase === 'completed')
      return <ErrorLine label="Couldn't read the Granola note list." />;
    return <Placeholder label="Loading your Granola notes…" />;
  }
  if (result.status === 'malformed')
    return <ErrorLine label="Couldn't read the Granola note list." />;
  if (result.value.length === 0) return <Placeholder label="No Granola notes were found." />;

  const selectable =
    (selectPhase === 'awaiting-signal' || selectPhase === 'in-flight') && !signalPending;
  if (selectPhase === 'completed') {
    return <Placeholder label="Note selected. Fetching the transcript…" />;
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[10px] border border-orange/20 bg-orange/5 px-3 py-2">
        <p className="text-[12px] font-medium text-text-2">Pick the customer call to mine</p>
        <p className="mt-0.5 text-[12px] text-text-3">
          Myra will extract pain points, customer language, and proof points from the selected
          transcript.
        </p>
      </div>
      <ul className="grid gap-2">
        {result.value.map((note) => {
          const pending = pendingNoteId === note.id;
          return (
            <li key={note.id}>
              <button
                type="button"
                disabled={!selectable || pendingNoteId !== null}
                onClick={() => {
                  if (!selectable || pendingNoteId !== null) return;
                  setPendingNoteId(note.id);
                  onSelect(note.id);
                }}
                className="group w-full rounded-[12px] border border-border bg-bg px-4 py-3 text-left shadow-sm transition-colors enabled:hover:border-orange enabled:hover:bg-orange/5 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-text">
                      {note.title ?? 'Untitled note'}
                    </span>
                    {note.summary ? (
                      <span className="mt-1 line-clamp-2 block text-[12px] leading-relaxed text-text-3">
                        {note.summary}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-text-3 group-enabled:group-hover:border-orange/50 group-enabled:group-hover:text-orange">
                    {pending ? 'Opening…' : 'Select'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// -------------------------------------------------------------------------
// Step 2 — Context input
// -------------------------------------------------------------------------

function ContextStep({
  stepOutputs,
  contextPhase,
  fetchPhase,
  signalPending,
  onSubmit,
}: {
  stepOutputs: Record<string, unknown>;
  contextPhase: StepPhase | undefined;
  fetchPhase: StepPhase | undefined;
  signalPending: boolean;
  onSubmit: (context: string) => void;
}) {
  const [value, setValue] = useState('');

  if (contextPhase === 'completed') {
    return <Placeholder label="Context saved. Analyzing pain points…" />;
  }

  const awaiting = contextPhase === 'awaiting-signal' || contextPhase === 'in-flight';
  const buttonDisabled = !awaiting || signalPending;

  const fetchResult = parseFetchedNote(stepOutputs.fetch);
  const noteTitle =
    fetchResult.status === 'ok' ? (fetchResult.value.title ?? undefined) : undefined;

  return (
    <div className="space-y-3">
      {noteTitle ? (
        <p className="text-[12px] text-text-3">
          Transcript: <span className="font-medium text-text-2">{noteTitle}</span>
        </p>
      ) : null}
      {!noteTitle && fetchPhase === 'in-flight' ? (
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
        disabled={buttonDisabled}
        onClick={() => {
          if (buttonDisabled) return;
          onSubmit(value.trim());
        }}
      >
        {signalPending ? 'Continuing…' : 'Continue'}
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
  signalPending,
  onSubmit,
}: {
  stepOutputs: Record<string, unknown>;
  analyzePhase: StepPhase | undefined;
  ppSelectionPhase: StepPhase | undefined;
  signalPending: boolean;
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
  const disabled = !awaiting || signalPending;

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
                  disabled={disabled}
                  checked={checked}
                  onChange={() => toggle(pp.id)}
                  className="mt-0.5 h-4 w-4 accent-orange disabled:cursor-not-allowed"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-medium text-text">{pp.title}</p>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${severityClass(
                        pp.severity
                      )}`}
                    >
                      {severityLabel(pp.severity)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-text-3">{pp.detail}</p>
                </div>
              </label>
            </li>
          );
        })}
      </ul>

      <Button
        variant="primary"
        size="sm"
        disabled={disabled || selected.size === 0}
        onClick={() => {
          if (disabled) return;
          onSubmit([...selected]);
        }}
      >
        {signalPending ? 'Selecting…' : 'Select'}{' '}
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
  signalPending,
  onSubmit,
}: {
  fmtSelectionPhase: StepPhase | undefined;
  signalPending: boolean;
  onSubmit: (formats: Array<{ format: string }>) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (fmtSelectionPhase === 'completed') {
    return <Placeholder label="Formats selected. Generating collateral…" />;
  }

  const awaiting = fmtSelectionPhase === 'awaiting-signal' || fmtSelectionPhase === 'in-flight';
  const disabled = !awaiting || signalPending;

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
                  disabled={disabled}
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
        disabled={disabled || selected.size === 0}
        onClick={() => {
          if (disabled) return;
          onSubmit([...selected].map((format) => ({ format })));
        }}
      >
        {signalPending ? 'Generating…' : 'Generate'}{' '}
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

type Decision = { piece: GeneratedPiece; approved: boolean | null };

function ReviewStep({
  stepOutputs,
  generatePhase,
  reviewPhase,
  signalPending,
  onSubmit,
}: {
  stepOutputs: Record<string, unknown>;
  generatePhase: StepPhase | undefined;
  reviewPhase: StepPhase | undefined;
  signalPending: boolean;
  onSubmit: (decisions: Decision[]) => void;
}) {
  const result = useMemo(() => parseGeneratedPieces(stepOutputs.generate), [stepOutputs.generate]);
  const [decisions, setDecisions] = useState<Decision[]>(() =>
    result.status === 'ok' ? result.value.map((piece) => ({ piece, approved: null })) : []
  );

  const pieces = result.status === 'ok' ? result.value : [];
  const synced =
    decisions.length === pieces.length &&
    decisions.every((d, i) => d.piece.format === pieces[i]?.format);

  useEffect(() => {
    if (result.status === 'ok' && !synced) {
      setDecisions(pieces.map((piece) => ({ piece, approved: null })));
    }
  }, [pieces, result.status, synced]);

  if (reviewPhase === 'completed') {
    return <Placeholder label="Review complete. Saving…" />;
  }

  if (result.status === 'pending') {
    if (generatePhase === 'completed')
      return <ErrorLine label="Couldn't read the generated collateral." />;
    return <Placeholder label="Generating collateral…" />;
  }
  if (result.status === 'malformed')
    return <ErrorLine label="Couldn't read the generated collateral." />;

  const activeDec: Decision[] = synced
    ? decisions
    : pieces.map((piece) => ({ piece, approved: null }));

  const awaiting = reviewPhase === 'awaiting-signal' || reviewPhase === 'in-flight';
  // Approve / Deny / Back are pure-local card navigation — they fire no signal,
  // so they stay enabled regardless of signalPending. Only the final submit
  // posts the review signal and obeys signalPending.
  const decideDisabled = !awaiting;
  const submitDisabled = !awaiting || signalPending;
  const activeIndex = activeDec.findIndex((d) => d.approved === null);
  const activeDecision = activeIndex >= 0 ? activeDec[activeIndex] : null;
  const approvedCount = activeDec.filter((d) => d.approved === true).length;
  const deniedCount = activeDec.filter((d) => d.approved === false).length;
  // The card immediately before the active one (or the last card when every
  // piece is decided). Back re-opens it by clearing its decision.
  const lastDecidedIndex = activeIndex > 0 ? activeIndex - 1 : activeDec.length - 1;
  const canGoBack = activeDec.some((d) => d.approved !== null);

  function decide(index: number, approved: boolean) {
    if (decideDisabled || index < 0) return;
    setDecisions((prev) => {
      const base = synced
        ? [...prev]
        : pieces.map((p, i) => ({ piece: p, approved: prev[i]?.approved ?? null }));
      return base.map((d, i) => (i === index ? { ...d, approved } : d));
    });
  }

  function goBack() {
    if (decideDisabled || !canGoBack || lastDecidedIndex < 0) return;
    setDecisions((prev) => {
      const base = synced
        ? [...prev]
        : pieces.map((p, i) => ({ piece: p, approved: prev[i]?.approved ?? null }));
      return base.map((d, i) => (i === lastDecidedIndex ? { ...d, approved: null } : d));
    });
  }

  function submitReview() {
    if (submitDisabled || activeDec.some((d) => d.approved === null)) return;
    onSubmit(activeDec);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[10px] border border-border bg-bg p-3">
        <div className="mb-2 flex items-center justify-between text-[12px] text-text-3">
          <span>Review queue</span>
          <span>
            {approvedCount} approved · {deniedCount} denied
          </span>
        </div>
        <ol className="grid gap-1.5">
          {activeDec.map((dec, index) => {
            const current = index === activeIndex;
            const status = decisionStatus(dec);
            return (
              <li
                key={dec.piece.format}
                className={`flex items-center justify-between gap-3 rounded-[7px] border px-3 py-2 text-[12px] ${
                  current
                    ? 'border-orange bg-orange/5 text-text'
                    : 'border-border bg-surface text-text-2'
                }`}
              >
                <span className="truncate">
                  {index + 1}. {dec.piece.format} — {dec.piece.title}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${decisionBadgeClass(
                    dec.approved
                  )}`}
                >
                  {status}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {activeDecision ? (
        <div className="flex min-h-[420px] flex-col rounded-[14px] border border-border bg-surface shadow-sm">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">
                {activeDecision.piece.format}
              </span>
              <h3 className="mt-3 text-[16px] font-semibold text-text">
                {activeDecision.piece.title}
              </h3>
            </div>
            {canGoBack ? (
              <button
                type="button"
                disabled={decideDisabled}
                onClick={goBack}
                className="shrink-0 rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors enabled:hover:bg-surface-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
              >
                Back
              </button>
            ) : null}
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <Markdown>{activeDecision.piece.content}</Markdown>
          </div>
          <div className="grid grid-cols-2 gap-3 border-t border-border bg-bg p-4">
            <button
              type="button"
              disabled={decideDisabled}
              onClick={() => decide(activeIndex, false)}
              className="rounded-[12px] border border-orange/40 bg-orange/10 px-4 py-3 text-[14px] font-semibold text-orange transition-colors enabled:hover:bg-orange/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Deny
            </button>
            <button
              type="button"
              disabled={decideDisabled}
              onClick={() => decide(activeIndex, true)}
              className="rounded-[12px] border border-green/40 bg-green/10 px-4 py-3 text-[14px] font-semibold text-green transition-colors enabled:hover:bg-green/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Approve
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 rounded-[14px] border border-border bg-surface p-5">
          <div>
            <h3 className="text-[15px] font-semibold text-text">Review complete</h3>
            <p className="mt-1 text-[12px] text-text-3">
              {approvedCount} approved · {deniedCount} denied before saving collateral.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="sm"
              disabled={submitDisabled || activeDec.some((d) => d.approved === null)}
              onClick={submitReview}
            >
              {signalPending ? 'Saving…' : 'Save Collateral to Artifacts'}
            </Button>
            {canGoBack ? (
              <button
                type="button"
                disabled={decideDisabled}
                onClick={goBack}
                className="rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors enabled:hover:bg-surface-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
              >
                Back
              </button>
            ) : null}
          </div>
        </div>
      )}
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
    return <Placeholder label="Saving collateral to artifacts…" />;
  }

  const result = parsePersistOutput(stepOutputs.review);
  const decisions = result.status === 'ok' ? result.value.decisions : [];
  const approved = decisions.filter((decision) => decision.approved);

  return (
    <div className="space-y-4">
      <p className="text-[13px] font-medium text-text">
        {approved.length > 0 ? 'Approved artifacts created successfully.' : 'Run complete.'}
      </p>
      {decisions.length > 0 && (
        <ul className="space-y-1.5">
          {decisions.map((d) => (
            <li
              key={d.format}
              className="flex items-center justify-between gap-3 rounded-[7px] border border-border bg-surface px-3 py-2 text-[13px] text-text"
            >
              <span className="min-w-0">
                <span className="mr-2 rounded-[5px] bg-surface-2 px-2 py-0.5 text-[11px] text-text-3">
                  {d.format}
                </span>
                <span className="truncate">{d.title}</span>
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${decisionBadgeClass(
                  d.approved
                )}`}
              >
                {decisionStatus({ piece: d, approved: d.approved })}
              </span>
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
  const { state, connected, signalPending, stepOutputs, onSignal, onClose } = props;

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
              signalPending={signalPending}
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
              signalPending={signalPending}
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
              signalPending={signalPending}
              onSubmit={(selectedIds) => onSignal('pain-point-selection', { selectedIds })}
            />
          </SectionCard>
        )}

        {/* Group 3 — Generate: fmtSelection signal → generate map */}
        {group === 'formats' && (
          <SectionCard title="Choose formats">
            <FormatStep
              fmtSelectionPhase={phaseFor(state, 'fmtSelection')}
              signalPending={signalPending}
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
              signalPending={signalPending}
              onSubmit={(decisions) => {
                const payloadDecisions = decisions.map(({ piece, approved }) => ({
                  format: piece.format,
                  title: piece.title,
                  content: piece.content,
                  approved: approved === true,
                }));
                onSignal('review', {
                  decisions: payloadDecisions,
                  approvedPieces: payloadDecisions
                    .filter((decision) => decision.approved)
                    .map(({ format, title, content }) => ({ format, title, content })),
                });
              }}
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
