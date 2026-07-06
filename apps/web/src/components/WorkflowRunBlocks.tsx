import { useMemo } from "react";
import {
  UIBlockView,
  DockRunPhaseSchema,
  type DockRunPhase,
  type UIResponse,
} from "@workbench/chat";
import { Button, failedRunError, toHumanLabel } from "@workbench/ui";
import { buildDockBlocks } from "../lib/dock-block-builders";
import type { RunPhase, RunState, StepState } from "@intx/workflow";
import type { LogRunState } from "../lib/run-state-adapter";

const RUN_PHASE_LABELS: Record<RunPhase, string> = {
  pending: "Pending",
  running: "Running",
  cancelling: "Cancelling",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

// The active step for the header subtitle: the first step in-flight or parked on
// a gate; if none, the first non-terminal step; else the last step overall.
function deriveActiveStep(steps: readonly StepState[]): StepState | null {
  const inFlight = steps.find(
    (s) =>
      s.phase === "in-flight" ||
      s.phase === "awaiting-signal" ||
      s.phase === "awaiting-timer",
  );
  if (inFlight) return inFlight;
  const nonCompleted = steps.find(
    (s) => s.phase !== "completed" && s.phase !== "cancelled",
  );
  if (nonCompleted) return nonCompleted;
  return steps[steps.length - 1] ?? null;
}

interface WorkflowRunBlocksProps {
  runId: string;
  kind: string;
  // Reconciled run state — drives the header phase/active step and the run-level
  // phase handed to the block builders.
  state: RunState;
  // The run's log-derived steps (the block builders' step source) and decoded
  // step outputs. Undefined until the first /state frame lands.
  logState: LogRunState | undefined;
  stepOutputs: Record<string, unknown>;
  // Run settled (completed/failed) — gates the terminal-failure affordance.
  terminal: boolean;
  // Index says failed but the log is still non-terminal: the run was killed
  // externally (redeploy/abort), not a genuine step failure — the copy differs.
  interrupted: boolean;
  onRespond: (response: UIResponse) => void | Promise<void>;
  onClose: () => void;
}

// Generic workflow-run view driven by UIBlocks — the same block substrate the
// chat dock renders (CL-2683). Replaces the raw RunConsole fallback so a workflow
// with no bespoke Panel renders a clean progress timeline, a typed gate choice,
// and error/link blocks instead of dumping `step.outputRef` as raw JSON. A
// migrated kind supplies its own builder via `buildDockBlocks`; every other kind
// falls through to the generic synthesis. No workflow-kind branching lives here.
export function WorkflowRunBlocks({
  runId,
  kind,
  state,
  logState,
  stepOutputs,
  terminal,
  interrupted,
  onRespond,
  onClose,
}: WorkflowRunBlocksProps) {
  const steps = useMemo(() => [...state.steps.values()], [state]);
  const activeStep = useMemo(() => deriveActiveStep(steps), [steps]);
  const activeIndex = activeStep
    ? steps.findIndex((s) => s.stepId === activeStep.stepId) + 1
    : null;

  const phase: DockRunPhase = DockRunPhaseSchema.allows(state.phase)
    ? state.phase
    : "running";
  const sanitizedError = failedRunError(state)?.userMessage;

  const blocks = useMemo(
    () =>
      buildDockBlocks(kind, {
        runId,
        phase,
        steps: (logState?.steps ?? []).map((step) => ({
          stepId: step.stepId,
          phase: step.phase,
          ...(step.awaitingSignalName !== undefined
            ? { awaitingSignalName: step.awaitingSignalName }
            : {}),
        })),
        stepOutputs,
        ...(sanitizedError !== undefined
          ? { errorMessage: sanitizedError }
          : {}),
      }),
    [kind, runId, phase, logState, stepOutputs, sanitizedError],
  );

  const headerSubtitle =
    activeStep && activeIndex !== null
      ? `Step ${String(activeIndex)} of ${String(steps.length)} · ${toHumanLabel(activeStep.stepId)}`
      : toHumanLabel(kind);

  // A run parked on a gate reports phase `running` (RunPhase has no `awaiting`
  // member), so surface the HITL "needs you" cue in amber — matching the dock's
  // STATUS_META, the single highest-value signal for a HITL workflow. Otherwise
  // the plain run-phase label.
  const awaitingGate = steps.some((s) => s.phase === "awaiting-signal");
  const phaseLabel = awaitingGate ? "Needs you" : RUN_PHASE_LABELS[state.phase];

  // A failed run needs an explicit "what to do next" even when no step carries a
  // classified error (an interrupted run has none) — the error block alone would
  // leave the pane blank. Interrupted vs genuinely-failed copy mirrors the prior
  // console. The classified message, when present, already renders as an error
  // block above, so we only add the restart affordance here.
  const failed = terminal && state.phase === "failed";
  const failureCopy = interrupted
    ? "This run was interrupted and can't continue. Start a new run to pick up where you left off."
    : sanitizedError === undefined
      ? "This run failed. Start a new run to try again."
      : null;

  return (
    <div className="flex h-full flex-col overflow-hidden border border-border bg-bg">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-text">
            Workflow run
          </p>
          <p className="truncate text-[12px] text-text-3">{headerSubtitle}</p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`text-[12px] font-medium ${awaitingGate ? "text-orange" : "text-text-2"}`}
          >
            {phaseLabel}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>

      <div
        role="status"
        aria-live="polite"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {blocks.map((block, index) => (
          <UIBlockView key={index} block={block} onRespond={onRespond} />
        ))}

        {failed && (
          <div className="flex flex-col items-start gap-3">
            {failureCopy !== null && (
              <p className="text-[13px] text-text-3">{failureCopy}</p>
            )}
            <Button variant="primary" size="sm" onClick={onClose}>
              Back to workflows
            </Button>
          </div>
        )}

        {blocks.length === 0 && !terminal && (
          <p className="text-[13px] text-text-3">Waiting for run activity…</p>
        )}
      </div>
    </div>
  );
}
