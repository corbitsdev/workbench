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
 * The message from whichever step failed the run, or null if the run has not
 * failed or no step carries a `lastError`. `RunState.steps` has no run-level
 * error field — the failing step's own `lastError` (populated by the hub's
 * run-state adapter from the record's `error` field) is the only place the
 * message lives.
 *
 * Returns the first `lastError` found in map-iteration order. This relies on
 * the adapter's invariant that at most one step carries `lastError` per run
 * (`apps/web/src/lib/run-state-adapter.ts` only ever attaches it to the
 * single active/failed step) — if that invariant ever breaks, this picks an
 * arbitrary one rather than surfacing the ambiguity.
 */
export function failedRunErrorMessage(state: RunState | null): string | null {
  if (state?.phase !== "failed") return null;
  for (const step of state.steps.values()) {
    if (step.lastError !== undefined) return step.lastError.message;
  }
  return null;
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
