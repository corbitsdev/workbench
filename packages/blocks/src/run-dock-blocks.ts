/**
 * Derives a workflow-dock card's UIBlock[] from a run's log-derived state
 * (CL-2680). V1 of the "workflows as blocks" surface: until workflows emit
 * their own blocks (CL-2683/2684), the card content is synthesized here —
 * a progress block from the run's steps, an error block on failure (message
 * must already be sanitized by the caller; see @workbench/ui failedRunError),
 * and a link block on completion pointing at the run's full page.
 */
import { type } from "arktype";
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
});
export type DockRunStep = typeof DockRunStepSchema.infer;

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
