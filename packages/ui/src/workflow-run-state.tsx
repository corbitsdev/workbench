/**
 * Shared run-state reasoning for ALL workflow run panels — the six generic
 * panels and the clustered last30days panel both route screen + stepper state
 * through these helpers.
 *
 * Panels are fed a synthesized `RunState` (apps/web's run-state-adapter) built
 * from a thin, poll-driven run record: a step is only marked `completed` when it
 * appears in the record's `outputs` map. An `awaitSignal` gate's `StepCompleted`
 * can be absent from that record (projection lag / an unresolved output ref), so
 * a gate's own phase is an unreliable "done" signal. Every panel used to reason
 * about this independently and the naive "first step not completed" routing made
 * them all rewind to the gate screen mid-run. This module encodes the robust
 * rule once: a step is passed when its own phase is completed OR any later step
 * has progressed (CL-2506).
 *
 * Live status line. The single line under the stepper is driven by an activity
 * VERB, never a stepper noun: each work step carries an optional `activityLabel`
 * (a present-progress phrase like "Saving to workbench") that `liveStatusLabel`
 * surfaces only while that step is in-flight. A step with no `activityLabel`
 * (every human gate / intake) shows NO line rather than a misleading noun. A
 * panel may instead supply its OWN richer bespoke live line while still routing
 * through these helpers — last30days does exactly that, computing a dynamic
 * per-source line and passing it straight to `LiveStatusSlot`.
 */
import { AnimatePresence, motion } from "framer-motion";
import type { RunState, StepState } from "@intx/workflow";
import type { WorkflowStep } from "./workflow-step-types";
import { failedRunError } from "./workflow-run-error";

export type StepPhase = StepState["phase"];

export function getStepPhase(
  state: RunState | null,
  stepId: string,
): StepPhase | undefined {
  return state?.steps.get(stepId)?.phase;
}

export function isStepRunning(phase: StepPhase | undefined): boolean {
  return (
    phase === "in-flight" ||
    phase === "awaiting-signal" ||
    phase === "awaiting-timer"
  );
}

/**
 * A stepper entry backed by one or more runtime step ids, in run order. A linear
 * workflow maps one runtime id per display step; a clustered one (e.g. a
 * multi-source research phase) groups many. The last id is the group's terminal
 * step — the group reads `completed` only once it completes.
 */
export interface DisplayStep {
  key: string;
  label: string;
  stepIds: readonly string[];
  /**
   * Present-progress verb phrase shown on the live status line while this step
   * is in-flight (e.g. "Saving to workbench"). Omit for human gates and intake
   * steps — an unlabeled active step shows no line rather than a stepper noun.
   */
  activityLabel?: string;
}

/** The aggregate phase of a display step from its runtime steps. */
export function displayStepPhase(
  state: RunState | null,
  stepIds: readonly string[],
): StepPhase | undefined {
  if (stepIds.length === 0) return undefined;
  const terminal = stepIds[stepIds.length - 1];
  if (terminal !== undefined && getStepPhase(state, terminal) === "completed") {
    return "completed";
  }
  for (const id of stepIds) {
    const phase = getStepPhase(state, id);
    if (isStepRunning(phase)) return phase;
  }
  for (const id of stepIds) {
    if (getStepPhase(state, id) === "failed") return "failed";
  }
  // A middle step completed but the next has not started yet: still in-flight,
  // never idle (avoids an all-pending gap mid-group).
  for (const id of stepIds) {
    if (getStepPhase(state, id) !== undefined) return "in-flight";
  }
  return undefined;
}

function hasAnyProgress(state: RunState | null, step: DisplayStep): boolean {
  return step.stepIds.some((id) => getStepPhase(state, id) !== undefined);
}

/**
 * Index of the display step the run is currently on. Robust to a gate whose
 * `StepCompleted` is missing: a step is treated as passed when it is completed
 * OR any later step has progressed. Returns the last index once every step is
 * complete.
 *
 * A step whose own phase is `failed` is NEVER treated as passed, even if a
 * later, independently-running branch has progressed — independent DAG steps
 * run concurrently (AGENTS.md), so a later step's progress says nothing about
 * whether this one failed. Without this, the `laterProgressed` rule below
 * would silently re-label a failed step "completed" (CL-2654 follow-up).
 */
export function activeDisplayStepIndex(
  state: RunState | null,
  steps: readonly DisplayStep[],
): number {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    const phase = displayStepPhase(state, step.stepIds);
    if (phase === "completed") continue;
    if (phase === "failed") return i;
    const laterProgressed = steps
      .slice(i + 1)
      .some((later) => hasAnyProgress(state, later));
    if (laterProgressed) continue;
    return i;
  }
  return Math.max(0, steps.length - 1);
}

export function buildStepperSteps(
  state: RunState | null,
  steps: readonly DisplayStep[],
): WorkflowStep[] {
  const activeIdx = activeDisplayStepIndex(state, steps);
  // A completed run marks every entry done: the final step's output can lag
  // behind the run's terminal phase, and without this it would linger as
  // "current" on an already-finished run.
  const runCompleted = state?.phase === "completed";
  return steps.map((step, i) => {
    let status: WorkflowStep["status"];
    if (runCompleted || i < activeIdx) {
      status = "completed";
    } else if (i > activeIdx) {
      status = "pending";
    } else {
      const phase = displayStepPhase(state, step.stepIds);
      if (phase === "completed") {
        status = "completed";
      } else if (phase === "failed") {
        status = "failed";
      } else {
        status = "current";
      }
    }
    return { number: i + 1, label: step.label, status };
  });
}

/**
 * The active display step, or null while the run is terminal. The host uses this
 * to route screens robustly instead of a naive completion loop.
 */
export function activeDisplayStep(
  state: RunState | null,
  steps: readonly DisplayStep[],
): DisplayStep | null {
  if (steps.length === 0) return null;
  return steps[activeDisplayStepIndex(state, steps)] ?? null;
}

/**
 * The "what's happening now" verb for the live status line, taken from the
 * active step's `activityLabel`. Returns null — showing NO line — when:
 *   - there is no run state, or the run is terminal (failed / completed);
 *   - the active step is the first step (intake/config owns its own loading UI);
 *   - the active group is completed or parked on a human gate (awaiting-signal);
 *   - the active step has no `activityLabel` (a gate / intake step) — silence is
 *     correct here, never the stepper noun, which would mislead (e.g. show
 *     "Review…" while a draft is actually generating).
 */
export function liveStatusLabel(
  state: RunState | null,
  steps: readonly DisplayStep[],
): string | null {
  if (state === null) return null;
  if (state.phase === "failed" || state.phase === "completed") return null;
  const idx = activeDisplayStepIndex(state, steps);
  if (idx === 0) return null;
  const step = steps[idx];
  if (step === undefined) return null;
  const phase = displayStepPhase(state, step.stepIds);
  if (phase === "completed" || phase === "awaiting-signal") return null;
  return step.activityLabel ?? null;
}

/**
 * The SANITIZED end-user message from whichever step failed the run, or null
 * if the run has not failed or no step carries a `lastError`. `RunState.steps`
 * has no run-level error field — the failing step's own `lastError` (populated
 * by the hub's run-state adapter from the record's `error` field) is the only
 * place the message lives.
 *
 * The raw error is never returned here: it is classified through
 * `classifyRunError` (workflow-run-error.ts), so known-safe external shapes
 * render a plain-language message and everything else degrades to a generic
 * one (CL-2660). Operator surfaces that need the raw text use
 * `failedRunError(state).raw` instead.
 *
 * Uses the first `lastError` found in map-iteration order. This relies on
 * the adapter's invariant that at most one step carries `lastError` per run
 * (`apps/web/src/lib/run-state-adapter.ts` only ever attaches it to the
 * single active/failed step) — if that invariant ever breaks, this picks an
 * arbitrary one rather than surfacing the ambiguity.
 */
export function failedRunErrorMessage(state: RunState | null): string | null {
  return failedRunError(state)?.userMessage ?? null;
}

/**
 * Label of the first display step whose aggregate phase is `failed`, or null.
 * Deliberately does NOT require `state.phase === "failed"`: a panel that flags
 * failure from a single failed step before the run's own phase flips (e.g.
 * pain-point-collateral's hasFailed) still gets the step name.
 */
export function failedDisplayStepLabel(
  state: RunState | null,
  steps: readonly DisplayStep[],
): string | null {
  if (state === null) return null;
  for (const step of steps) {
    if (displayStepPhase(state, step.stepIds) === "failed") return step.label;
  }
  return null;
}

/**
 * True only for a genuine never-started run: the run has failed, its step map is
 * empty, AND that emptiness came from an event log that was actually READ
 * (`logRead === true`). The CL-2727 liveness sweep marks a stuck-starting run
 * `failed` in the index while its read log holds no step, so the folded state
 * carries a terminal phase with a genuinely-empty step map — that is the only
 * case that earns the honest "This run didn't start" copy.
 *
 * An empty step map is NOT sufficient on its own: the log-unavailable fallback
 * (`runStateFromRecord` — a legacy deployment-less run or a log read error)
 * synthesizes the same `{phase:"failed", steps:∅}` shape for ANY failed run,
 * even one that genuinely progressed far before failing. In that case we do not
 * know whether it started, so `logRead` is false and this returns false — the
 * caller shows the generic "Run failed" copy instead of falsely claiming it
 * never started (CL-2729).
 */
export function runNeverStarted(
  state: RunState | null,
  logRead: boolean,
): boolean {
  return state !== null && logRead && state.steps.size === 0;
}

/**
 * Honest copy for the pre-interactive window of a run's FIRST step: the run
 * record exists but the log has not yet recorded any step activity, so the panel
 * cannot yet show a gate or an activity line. Driven by the folded run-level
 * phase — `pending` (or no state yet) means the run is queued to start; anything
 * else means the runtime is booting the first step. Never an indefinite "waiting"
 * placeholder: every phase maps to a truthful present-progress line.
 */
export function runStartLabel(state: RunState | null): string {
  if (state === null || state.phase === "pending")
    return "Starting your workflow…";
  return "Preparing your workflow…";
}

const NO_ERROR_DETAILS =
  "No error details are available. Start a new run to try again.";

const NEVER_STARTED_DETAILS =
  "This run couldn't be started. Start a new run to try again.";

const LOG_UNAVAILABLE_DETAILS =
  "We couldn't load this run's details. Refresh to try again, or start a new run.";

/**
 * The one failed-run notice every workflow panel renders (CL-2659): which
 * display step failed plus the SANITIZED error from the shared classifier
 * (CL-2660) — never the raw step error, and never bespoke per-panel error
 * text. Falls back to an honest no-details line when no step carries a
 * `lastError`.
 *
 * `logRead` tells the two identical-looking empty-step shapes apart (CL-2729):
 * `true` when the empty step map came from an event log that was actually read
 * (the genuine never-started sweep case → "This run didn't start"), `false` when
 * the log was unavailable and the state was synthesized from the run index (a
 * legacy deployment-less run or a read error → we don't know whether it started,
 * so show the generic "Run failed" / couldn't-load copy, never a false
 * didn't-start claim).
 */
export function FailedRunNotice({
  state,
  steps,
  logRead,
}: {
  state: RunState | null;
  steps: readonly DisplayStep[];
  logRead: boolean;
}) {
  const neverStarted = runNeverStarted(state, logRead);
  const logUnavailable = !logRead && state !== null && state.steps.size === 0;
  const stepLabel = failedDisplayStepLabel(state, steps);
  let heading: string;
  if (neverStarted) {
    heading = "This run didn't start";
  } else if (stepLabel === null) {
    heading = "Run failed";
  } else {
    heading = `Run failed at ${stepLabel}`;
  }
  let fallbackDetails: string;
  if (neverStarted) {
    fallbackDetails = NEVER_STARTED_DETAILS;
  } else if (logUnavailable) {
    fallbackDetails = LOG_UNAVAILABLE_DETAILS;
  } else {
    fallbackDetails = NO_ERROR_DETAILS;
  }
  return (
    <div
      role="alert"
      className="border-orange bg-orange-soft rounded-panel border p-4"
    >
      <p className="text-orange-deep text-sm font-medium">{heading}</p>
      <p className="text-orange-deep mt-1 text-sm">
        {failedRunErrorMessage(state) ?? fallbackDetails}
      </p>
    </div>
  );
}

/** The single live progress line shown under the stepper. */
export function LiveStatus({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-6 py-2.5 text-sm text-text-2">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-blue motion-reduce:animate-none" />
      {label}…
    </div>
  );
}

/**
 * Layout-stable wrapper for the live line: animates its height 0→auto and
 * opacity 0→1 on enter and reverses on exit, so the body no longer jumps ~32px
 * at every gate↔processing boundary. Render it unconditionally with the
 * computed label; a null label animates the line out.
 */
export function LiveStatusSlot({ label }: { label: string | null }) {
  return (
    <AnimatePresence initial={false}>
      {label !== null ? (
        <motion.div
          key="live-status"
          role="status"
          aria-live="polite"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="overflow-hidden"
        >
          <LiveStatus label={label} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
