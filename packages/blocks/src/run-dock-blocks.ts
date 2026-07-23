/**
 * Derives a workflow-dock card's UIBlock[] from a run's log-derived state
 * (CL-2680). V1 of the "workflows as blocks" surface: until workflows emit
 * their own blocks (CL-2683/2684), the card content is synthesized here —
 * a progress block from the run's steps, an error block on failure (message
 * must already be sanitized by the caller; see @workbench/ui failedRunError),
 * and a link block on completion pointing at the run's full page.
 */
import { type } from "arktype";
import { pendingGateForRun } from "./conversation-gates";
import type { ProgressStep, ProgressStepState, UIBlock } from "./ui-block";

export const DockStepPhaseSchema = type(
  "'in-flight'|'awaiting-signal'|'awaiting-timer'|'completed'|'failed'|'cancelled'",
);
export type DockStepPhase = typeof DockStepPhaseSchema.infer;

export const DockRunPhaseSchema = type(
  "'pending'|'running'|'cancelling'|'completed'|'failed'|'cancelled'",
);
export type DockRunPhase = typeof DockRunPhaseSchema.infer;

export const DockRunStepSchema = type({
  stepId: "string",
  phase: DockStepPhaseSchema,
  // The gate's `awaitSignal` name, recovered from the run's log state (CL-2681).
  // Present only on a step parked on a gate; drives the resume affordance.
  "awaitingSignalName?": "string",
  // The step's classified failure, carried through from the log fold (CL-4284).
  // Lets a gate whose input comes from an EARLIER step tell "that step failed"
  // apart from "its output just isn't readable here" instead of collapsing both
  // into the same dead-end run-page link.
  "lastError?": { message: "string" },
});
export type DockRunStep = typeof DockRunStepSchema.infer;

export const DockSurfaceSchema = type("'dock'|'run-page'");
export type DockSurface = typeof DockSurfaceSchema.infer;

export const DockRunInputSchema = type({
  runId: "string",
  phase: DockRunPhaseSchema,
  steps: DockRunStepSchema.array(),
  "errorMessage?": "string",
  "completedLink?": {
    url: "string",
    title: "string",
    "description?": "string",
  },
  // Which surface is rendering these blocks (CL-4284) — the chat dock or the
  // run's own page. A run-page link is a dead end when it's already the page
  // being viewed, so block builders must gate it on this. Undefined (the
  // pre-CL-4284 callers) behaves as "dock" — the existing, more-common case.
  "surface?": DockSurfaceSchema,
});
export type DockRunInput = typeof DockRunInputSchema.infer;

const STEP_PHASE_TO_PROGRESS: Record<DockStepPhase, ProgressStepState> = {
  "in-flight": "running",
  "awaiting-signal": "awaiting",
  "awaiting-timer": "awaiting",
  completed: "done",
  failed: "failed",
  cancelled: "failed",
};

export function progressStateForStepPhase(
  phase: DockStepPhase,
): ProgressStepState {
  return STEP_PHASE_TO_PROGRESS[phase];
}

function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/gu, " ").trim();
}

export function dockRunBlocks(run: DockRunInput): UIBlock[] {
  const blocks: UIBlock[] = [];
  if (run.steps.length > 0) {
    const steps: ProgressStep[] = run.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }
  // A run parked on a resolvable gate gets an explicit resume affordance: a
  // choice block carrying the gate's signalName (CL-2681). Selecting it POSTs a
  // resume with that signal — the same contract free text uses, and the button
  // is how a human disambiguates when more than one run in the conversation is
  // waiting. Omitted when the gate's signalName is unrecoverable (no target).
  const gate = pendingGateForRun({
    runId: run.runId,
    steps: run.steps,
  });
  if (gate !== null) {
    blocks.push({
      kind: "choice",
      prompt: "This run is waiting for your input.",
      signalName: gate.signalName,
      options: [{ id: "continue", label: "Continue", value: "" }],
    });
  }
  if (run.phase === "failed" && run.errorMessage !== undefined) {
    blocks.push({ kind: "error", message: run.errorMessage });
  }
  if (run.phase === "completed" && run.completedLink !== undefined) {
    blocks.push({
      kind: "link",
      url: run.completedLink.url,
      title: run.completedLink.title,
      ...(run.completedLink.description !== undefined
        ? { description: run.completedLink.description }
        : {}),
    });
  }
  return blocks;
}
