import { useEffect, useMemo, useState } from "react";
import { type } from "arktype";
import {
  activeDisplayStepIndex,
  buildRunStepperSteps,
  Button,
  type DisplayStep,
  FailedRunNotice,
  HorizontalStepper,
  LiveStatusSlot,
  liveStatusLabel,
  Markdown,
  type WorkflowPanelProps,
  type WorkflowStep,
} from "@workbench/ui";
import type { RunState } from "@intx/workflow";
import {
  parseAnalyze,
  parseFetchedNote,
  parseGeneratedPieces,
  parseNoteList,
  parsePersistOutput,
  PpSelectionOutput,
  type GeneratedPiece,
  type PainPoint,
} from "./parse";

// -------------------------------------------------------------------------
// Step configuration
// -------------------------------------------------------------------------

// Each stepper entry clusters the internal workflow steps it represents, in run
// order. The shared helpers compute stepper status / active step from this with
// the robust "passed = completed OR a later step progressed" rule, so a gate
// whose output is missing from the synthesized record can't rewind the panel,
// and fmtSelection naturally advances to Review once generate starts (CL-2506).
// `activityLabel` drives the live line from the in-flight machine work, never
// the stepper noun: while `generate` runs the line reads "Generating
// collateral", not the gate noun "Review". Gate-only groups (Transcript,
// Context, Generate=fmtSelection) carry none.
const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "transcript",
    label: "Transcript",
    stepIds: ["intake", "select", "fetch"],
  },
  { key: "context", label: "Context", stepIds: ["context"] },
  {
    key: "painPoints",
    label: "Pain Points",
    stepIds: ["analyze", "ppSelection"],
    activityLabel: "Analyzing the call",
  },
  { key: "formats", label: "Generate", stepIds: ["fmtSelection"] },
  {
    key: "review",
    label: "Review",
    stepIds: ["generate", "review"],
    activityLabel: "Generating collateral",
  },
  {
    key: "done",
    label: "Done",
    stepIds: ["persist"],
    activityLabel: "Saving to workbench",
  },
];

type StepPhase = NonNullable<ReturnType<RunState["steps"]["get"]>>["phase"];

// -------------------------------------------------------------------------
// Phase / stepper helpers
// -------------------------------------------------------------------------

// All internal workflow step IDs — used by hasFailed to cover non-display steps
const ALL_STEP_IDS = [
  "intake",
  "select",
  "fetch",
  "context",
  "analyze",
  "ppSelection",
  "fmtSelection",
  "generate",
  "review",
  "persist",
] as const;

function phaseFor(state: RunState | null, id: string): StepPhase | undefined {
  return state?.steps.get(id)?.phase;
}

function activeDisplayIndex(state: RunState | null): number {
  return activeDisplayStepIndex(state, DISPLAY_STEPS);
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return buildRunStepperSteps(state, DISPLAY_STEPS);
}

function hasFailed(state: RunState | null): boolean {
  if (!state) return false;
  if (state.phase === "failed") return true;
  for (const id of ALL_STEP_IDS) {
    if (phaseFor(state, id) === "failed") return true;
  }
  return false;
}

/**
 * Determine which "display group" is currently active. This drives which
 * SectionCard is rendered in the Panel body.
 */
type DisplayGroup =
  | "transcript"
  | "context"
  | "painPoints"
  | "formats"
  | "review"
  | "done";

function activeDisplayGroup(state: RunState | null): DisplayGroup {
  return (DISPLAY_STEPS[activeDisplayIndex(state)]?.key ??
    "done") as DisplayGroup;
}

// -------------------------------------------------------------------------
// Reusable sub-components
// -------------------------------------------------------------------------

const fieldClass =
  "w-full rounded-[8px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange";

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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

function severityLabel(severity: PainPoint["severity"]): string {
  if (severity === "critical") return "Critical";
  if (severity === "high") return "High";
  if (severity === "medium") return "Medium";
  return "Low";
}

function severityClass(severity: PainPoint["severity"]): string {
  if (severity === "critical")
    return "border-red-500/50 bg-red-500/10 text-red-300";
  if (severity === "high") return "border-orange/50 bg-orange/10 text-orange";
  if (severity === "medium")
    return "border-yellow-500/50 bg-yellow-500/10 text-yellow-300";
  return "border-green/40 bg-green/10 text-green";
}

function decisionStatus(decision: Decision): string {
  if (decision.approved === true) return "Approved";
  if (decision.approved === false) return "Denied";
  return "Pending";
}

function decisionBadgeClass(approved: boolean | null): string {
  if (approved === true) return "bg-green/10 text-green";
  if (approved === false) return "bg-orange/10 text-orange";
  return "bg-surface-2 text-text-3";
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
  const [openingNoteId, setOpeningNoteId] = useState<string | null>(null);
  const result = parseNoteList(stepOutputs.intake);

  if (result.status === "pending") {
    if (intakePhase === "completed")
      return <ErrorLine label="Couldn't read the Granola note list." />;
    return <Placeholder label="Loading your Granola notes…" />;
  }
  if (result.status === "malformed")
    return <ErrorLine label="Couldn't read the Granola note list." />;
  if (result.value.length === 0)
    return <Placeholder label="No Granola notes were found." />;

  // Server-guided gate: selectable only while the select step awaits its signal.
  // Once the optimistic cache flip reports the step `in-flight`, the buttons stay
  // disabled until the server advances to the next gate — no client submit flag.
  const selectable = selectPhase === "awaiting-signal";
  const selecting = selectPhase === "in-flight";
  if (selectPhase === "completed") {
    return <Placeholder label="Note selected. Fetching the transcript…" />;
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[10px] border border-orange/20 bg-orange/5 px-3 py-2">
        <p className="text-[12px] font-medium text-text-2">
          Pick the customer call to mine
        </p>
        <p className="mt-0.5 text-[12px] text-text-3">
          Myra will extract pain points, customer language, and proof points
          from the selected transcript.
        </p>
      </div>
      <ul className="grid gap-2">
        {result.value.map((note) => {
          return (
            <li key={note.id}>
              <button
                type="button"
                disabled={!selectable}
                onClick={() => {
                  if (!selectable) return;
                  setOpeningNoteId(note.id);
                  onSelect(note.id);
                }}
                className="group w-full rounded-[12px] border border-border bg-bg px-4 py-3 text-left shadow-sm transition-colors enabled:hover:border-orange enabled:hover:bg-orange/5 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-text">
                      {note.title ?? "Untitled note"}
                    </span>
                    {note.summary ? (
                      <span className="mt-1 line-clamp-2 block text-[12px] leading-relaxed text-text-3">
                        {note.summary}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-text-3 group-enabled:group-hover:border-orange/50 group-enabled:group-hover:text-orange">
                    {selecting && openingNoteId === note.id
                      ? "Opening…"
                      : "Select"}
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
  onSubmit,
}: {
  stepOutputs: Record<string, unknown>;
  contextPhase: StepPhase | undefined;
  fetchPhase: StepPhase | undefined;
  onSubmit: (context: string) => void;
}) {
  const [value, setValue] = useState("");

  if (contextPhase === "completed") {
    return <Placeholder label="Context saved. Analyzing pain points…" />;
  }

  const awaiting = contextPhase === "awaiting-signal";
  const submitting = contextPhase === "in-flight";
  const buttonDisabled = !awaiting;

  const fetchResult = parseFetchedNote(stepOutputs.fetch);
  const noteTitle =
    fetchResult.status === "ok"
      ? (fetchResult.value.title ?? undefined)
      : undefined;

  return (
    <div className="space-y-3">
      {noteTitle ? (
        <p className="text-[12px] text-text-3">
          Transcript:{" "}
          <span className="font-medium text-text-2">{noteTitle}</span>
        </p>
      ) : null}
      {!noteTitle && fetchPhase === "in-flight" ? (
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
        {submitting ? "Continuing…" : "Continue"}
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

  if (ppSelectionPhase === "completed") {
    return <Placeholder label="Pain points selected. Choose output formats…" />;
  }

  const result = parseAnalyze(stepOutputs.analyze);

  if (result.status === "pending") {
    if (analyzePhase === "completed")
      return <ErrorLine label="Couldn't read the extracted pain points." />;
    return <Placeholder label="Analyzing transcript for pain points…" />;
  }
  if (result.status === "malformed")
    return <ErrorLine label="Couldn't read the extracted pain points." />;

  const awaiting = ppSelectionPhase === "awaiting-signal";
  const submitting = ppSelectionPhase === "in-flight";
  const disabled = !awaiting;

  const MAX_PAIN_POINTS = 3;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_PAIN_POINTS) {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-text-3">
        Select up to {MAX_PAIN_POINTS} pain points to address in collateral.
      </p>
      <ul className="space-y-2">
        {result.value.map((pp) => {
          const checked = selected.has(pp.id);
          const atCap = selected.size >= MAX_PAIN_POINTS && !checked;
          return (
            <li key={pp.id}>
              <label className="flex cursor-pointer items-start gap-3 rounded-[8px] border border-border bg-bg px-3 py-2.5 transition-colors hover:border-orange has-[:checked]:border-orange has-[:checked]:bg-orange/5">
                <input
                  type="checkbox"
                  disabled={disabled || atCap}
                  checked={checked}
                  onChange={() => toggle(pp.id)}
                  className="mt-0.5 h-4 w-4 accent-orange disabled:cursor-not-allowed"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-medium text-text">
                      {pp.title}
                    </p>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${severityClass(
                        pp.severity,
                      )}`}
                    >
                      {severityLabel(pp.severity)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-text-3">
                    {pp.detail}
                  </p>
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
        {submitting ? "Selecting…" : "Select"}{" "}
        {selected.size > 0
          ? `${selected.size} pain point${selected.size === 1 ? "" : "s"}`
          : "pain points"}
      </Button>
    </div>
  );
}

// -------------------------------------------------------------------------
// Step 4 — Format selection
// -------------------------------------------------------------------------

const COLLATERAL_FORMATS: { id: string; label: string; description: string }[] =
  [
    {
      id: "email",
      label: "Email follow-up",
      description: "Draft a personal follow-up email to send after the call",
    },
    {
      id: "one-pager",
      label: "One-pager",
      description: "A sales leave-behind that stands on its own",
    },
    {
      id: "linkedin-post",
      label: "LinkedIn post",
      description: "First-person field observation for a professional audience",
    },
    {
      id: "linkedin-daily",
      label: "Daily LinkedIn post",
      description: "A practitioner-voice post with a concrete lesson",
    },
    {
      id: "twitter-post",
      label: "Twitter post",
      description: "Short first-person take built around one sharp insight",
    },
    {
      id: "founder-pov-post",
      label: "Founder POV post",
      description: "A founder perspective on the problem category",
    },
    {
      id: "blog",
      label: "Blog post",
      description: "Narrative arc with hook, story, and lessons",
    },
    {
      id: "case-study",
      label: "Case study",
      description: "Challenge, solution, and measurable results",
    },
    {
      id: "objection-handling",
      label: "Objection handling",
      description: "Tactical rebuttal guide for common buyer objections",
    },
    {
      id: "customer-quotes",
      label: "Customer quotes",
      description: "Curated verbatim quotes with context and theme",
    },
    {
      id: "battlecard",
      label: "Battlecard",
      description: "Competitive positioning reference for sellers",
    },
  ];

const MAX_FORMATS = 3;

function FormatStep({
  fmtSelectionPhase,
  onSubmit,
}: {
  fmtSelectionPhase: StepPhase | undefined;
  onSubmit: (formats: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (fmtSelectionPhase === "completed") {
    return <Placeholder label="Formats selected. Generating collateral…" />;
  }

  const awaiting = fmtSelectionPhase === "awaiting-signal";
  const submitting = fmtSelectionPhase === "in-flight";
  const disabled = !awaiting;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_FORMATS) {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-text-3">
        Choose up to {MAX_FORMATS} collateral formats.
      </p>
      <ul className="space-y-2">
        {COLLATERAL_FORMATS.map(({ id, label, description }) => {
          const checked = selected.has(id);
          const atCap = selected.size >= MAX_FORMATS && !checked;
          return (
            <li key={id}>
              <label className="flex cursor-pointer items-start gap-3 rounded-[8px] border border-border bg-bg px-3 py-2.5 transition-colors hover:border-orange has-[:checked]:border-orange has-[:checked]:bg-orange/5">
                <input
                  type="checkbox"
                  disabled={disabled || atCap}
                  checked={checked}
                  onChange={() => toggle(id)}
                  className="mt-0.5 h-4 w-4 accent-orange disabled:cursor-not-allowed"
                />
                <div>
                  <p className="text-[13px] font-medium text-text">
                    {description}
                  </p>
                  <p className="text-[12px] text-text-3">{label}</p>
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
        {submitting ? "Generating…" : "Generate"}{" "}
        {selected.size > 0
          ? `${selected.size} format${selected.size === 1 ? "" : "s"}`
          : "collateral"}
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
  onSubmit,
}: {
  stepOutputs: Record<string, unknown>;
  generatePhase: StepPhase | undefined;
  reviewPhase: StepPhase | undefined;
  onSubmit: (decisions: Decision[]) => void;
}) {
  const result = useMemo(
    () => parseGeneratedPieces(stepOutputs.generate),
    [stepOutputs.generate],
  );
  const [decisions, setDecisions] = useState<Decision[]>(() =>
    result.status === "ok"
      ? result.value.map((piece) => ({ piece, approved: null }))
      : [],
  );

  const pieces = result.status === "ok" ? result.value : [];
  const synced =
    decisions.length === pieces.length &&
    decisions.every((d, i) => d.piece.format === pieces[i]?.format);

  useEffect(() => {
    if (result.status === "ok" && !synced) {
      setDecisions(pieces.map((piece) => ({ piece, approved: null })));
    }
  }, [pieces, result.status, synced]);

  if (reviewPhase === "completed") {
    return <Placeholder label="Review complete. Saving…" />;
  }

  if (result.status === "pending") {
    if (generatePhase === "completed")
      return <ErrorLine label="Couldn't read the generated collateral." />;
    return <Placeholder label="Generating collateral…" />;
  }
  if (result.status === "malformed")
    return <ErrorLine label="Couldn't read the generated collateral." />;

  const activeDec: Decision[] = synced
    ? decisions
    : pieces.map((piece) => ({ piece, approved: null }));

  // Approve / Deny / Back are pure-local card navigation — they fire no signal,
  // so they stay usable through the whole review (awaiting-signal). Only the final
  // submit posts the review signal; it is server-guided — enabled iff the gate is
  // awaiting-signal, disabled the instant the optimistic cache flip reports
  // `in-flight`, and stays disabled until the server advances.
  const submitting = reviewPhase === "in-flight";
  const decideDisabled = reviewPhase !== "awaiting-signal";
  const submitDisabled = reviewPhase !== "awaiting-signal";
  const activeIndex = activeDec.findIndex((d) => d.approved === null);
  const activeDecision = activeIndex >= 0 ? activeDec[activeIndex] : null;
  const approvedCount = activeDec.filter((d) => d.approved === true).length;
  const deniedCount = activeDec.filter((d) => d.approved === false).length;
  // The card immediately before the active one (or the last card when every
  // piece is decided). Back re-opens it by clearing its decision.
  const lastDecidedIndex =
    activeIndex > 0 ? activeIndex - 1 : activeDec.length - 1;
  const canGoBack = activeDec.some((d) => d.approved !== null);

  function decide(index: number, approved: boolean) {
    if (decideDisabled || index < 0) return;
    setDecisions((prev) => {
      const base = synced
        ? [...prev]
        : pieces.map((p, i) => ({
            piece: p,
            approved: prev[i]?.approved ?? null,
          }));
      return base.map((d, i) => (i === index ? { ...d, approved } : d));
    });
  }

  function goBack() {
    if (decideDisabled || !canGoBack || lastDecidedIndex < 0) return;
    setDecisions((prev) => {
      const base = synced
        ? [...prev]
        : pieces.map((p, i) => ({
            piece: p,
            approved: prev[i]?.approved ?? null,
          }));
      return base.map((d, i) =>
        i === lastDecidedIndex ? { ...d, approved: null } : d,
      );
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
                    ? "border-orange bg-orange/5 text-text"
                    : "border-border bg-surface text-text-2"
                }`}
              >
                <span className="truncate">
                  {index + 1}. {dec.piece.format} — {dec.piece.title}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${decisionBadgeClass(
                    dec.approved,
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
            <h3 className="text-[15px] font-semibold text-text">
              Review complete
            </h3>
            <p className="mt-1 text-[12px] text-text-3">
              {approvedCount} approved · {deniedCount} denied before saving
              collateral.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="sm"
              disabled={
                submitDisabled || activeDec.some((d) => d.approved === null)
              }
              onClick={submitReview}
            >
              {submitting ? "Saving…" : "Save Collateral to Artifacts"}
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
  runCompleted,
  onClose,
}: {
  stepOutputs: Record<string, unknown>;
  persistPhase: StepPhase | undefined;
  runCompleted: boolean;
  onClose: () => void;
}) {
  if (persistPhase !== "completed" && !runCompleted) {
    return <Placeholder label="Finishing up…" />;
  }

  const result = parsePersistOutput(stepOutputs.review);
  const decisions = result.status === "ok" ? result.value.decisions : [];
  const approved = decisions.filter((decision) => decision.approved);

  return (
    <div className="space-y-4">
      <p className="text-[13px] font-medium text-text">
        {approved.length > 0
          ? "Approved artifacts created successfully."
          : "Run complete."}
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
                  d.approved,
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
  // `signalPending` is intentionally ignored: this panel is server-guided — every
  // gate control derives its disabled state from the polled run record's step
  // phase (awaiting-signal vs in-flight), not a client submit flag. The prop stays
  // on WorkflowPanelProps for the other panels until they migrate (CL-2258 f/u).
  const { state, connected, stepOutputs, onSignal, onClose } = props;

  const group = activeDisplayGroup(state);
  const failed = hasFailed(state);
  const stepperSteps = buildStepperSteps(state);
  // hasFailed also covers a single failed step before the run's own phase flips,
  // which liveStatusLabel does not suppress — guard it here.
  const liveLabel = failed ? null : liveStatusLabel(state, DISPLAY_STEPS);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">
            Collateral Generation
          </p>
          <p className="mt-px text-[11px] text-text-3">
            {connected ? "Live" : "Reconnecting…"}
          </p>
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
      <LiveStatusSlot label={liveLabel} />

      {/* Body — renders ONLY the active display group */}
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {failed && (
          <FailedRunNotice
            state={state}
            steps={DISPLAY_STEPS}
            logRead={props.logRead}
          />
        )}

        {/* Group 0 — Transcript: intake → select (note-selection signal) → fetch */}
        {group === "transcript" && (
          <SectionCard title="Select a Granola transcript">
            <TranscriptStep
              stepOutputs={stepOutputs}
              intakePhase={phaseFor(state, "intake")}
              selectPhase={phaseFor(state, "select")}
              onSelect={(noteId) => onSignal("note-selection", { noteId })}
            />
          </SectionCard>
        )}

        {/* Group 1 — Context: context signal */}
        {group === "context" && (
          <SectionCard title="Add context">
            <ContextStep
              stepOutputs={stepOutputs}
              contextPhase={phaseFor(state, "context")}
              fetchPhase={phaseFor(state, "fetch")}
              onSubmit={(context) => onSignal("context", { context })}
            />
          </SectionCard>
        )}

        {/* Group 2 — Pain Points: analyze → ppSelection signal */}
        {group === "painPoints" && (
          <SectionCard title="Select pain points">
            <PainPointStep
              stepOutputs={stepOutputs}
              analyzePhase={phaseFor(state, "analyze")}
              ppSelectionPhase={phaseFor(state, "ppSelection")}
              onSubmit={(selectedIds) =>
                onSignal("pain-point-selection", { selectedIds })
              }
            />
          </SectionCard>
        )}

        {/* Group 3 — Generate: fmtSelection signal → generate map */}
        {group === "formats" && (
          <SectionCard title="Choose formats">
            <FormatStep
              fmtSelectionPhase={phaseFor(state, "fmtSelection")}
              onSubmit={(formats) => {
                const ppOut = PpSelectionOutput(stepOutputs.ppSelection);
                const analyzeOut = parseAnalyze(stepOutputs.analyze);
                const selectedIds =
                  ppOut instanceof type.errors ? [] : ppOut.selectedIds;
                const painPoints =
                  analyzeOut.status === "ok" ? analyzeOut.value : [];
                const selectedPPs = painPoints
                  .filter((pp) => selectedIds.includes(pp.id))
                  .slice(0, MAX_FORMATS);
                const items = selectedPPs.flatMap((pp) =>
                  formats.slice(0, MAX_FORMATS).map((format) => ({
                    format,
                    painPointId: pp.id,
                    painPointTitle: pp.title,
                    painPointDetail: pp.detail,
                    severity: pp.severity ?? "medium",
                  })),
                );
                onSignal("format-selection", { items });
              }}
            />
          </SectionCard>
        )}

        {/* Group 4 — Review: review signal (show generated pieces above) */}
        {group === "review" && (
          <SectionCard title="Review collateral">
            <ReviewStep
              stepOutputs={stepOutputs}
              generatePhase={phaseFor(state, "generate")}
              reviewPhase={phaseFor(state, "review")}
              onSubmit={(decisions) => {
                const payloadDecisions = decisions.map(
                  ({ piece, approved }) => ({
                    format: piece.format,
                    title: piece.title,
                    content: piece.content,
                    approved: approved === true,
                  }),
                );
                onSignal("review", {
                  decisions: payloadDecisions,
                  approvedPieces: payloadDecisions
                    .filter((decision) => decision.approved)
                    .map(({ format, title, content }) => ({
                      format,
                      title,
                      content,
                    })),
                });
              }}
            />
          </SectionCard>
        )}

        {/* Group 5 — Done: persist map has run */}
        {group === "done" && (
          <SectionCard title="Done">
            <DoneStep
              stepOutputs={stepOutputs}
              persistPhase={phaseFor(state, "persist")}
              runCompleted={state?.phase === "completed"}
              onClose={onClose}
            />
          </SectionCard>
        )}
      </div>
    </div>
  );
}
