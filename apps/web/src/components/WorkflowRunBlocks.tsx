import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  UIBlockView,
  DockRunPhaseSchema,
  type DockRunPhase,
  type UIBlock,
  type UIResponse,
} from "@workbench/blocks";
import {
  activeDisplayStepIndex,
  Button,
  buildRunStepperSteps,
  failedRunError,
  HorizontalStepper,
  Skeleton,
  toHumanLabel,
  type DisplayStep,
} from "@workbench/ui";
import type { WorkflowFlowStep } from "@workbench/shared";
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

// A stable identity for a block across polls. The block list is recomputed in
// place on every /state frame (not append-only), so keying by array index would
// remount a block whenever the list length changes — wiping its local state and
// re-firing its entrance animation. Keying by kind + a discriminating field
// (the unified comparison block is a singleton; gates key by signal) lets the
// one comparison block stream its variants in place as the run progresses.
export function blockKey(block: UIBlock, index: number): string {
  switch (block.kind) {
    case "comparison":
      return "comparison";
    case "progress":
      return "progress";
    case "error":
      return "error";
    case "link":
      return `link:${block.url}`;
    case "choice":
      return `choice:${block.signalName ?? index}`;
    case "form":
      return `form:${block.signalName ?? index}`;
    case "multiSelect":
      return `multiSelect:${block.signalName ?? index}`;
    case "reviewList":
      return `reviewList:${block.signalName ?? index}`;
    default:
      return `${block.kind}:${index}`;
  }
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
  // The workflow's full, ordered step sequence from its DEFINITION (the same
  // classified list the Workflows catalog card preview renders), keyed by kind.
  // Undefined only while the catalog is still loading — the run pane's catalog
  // query is warm from the Workflows page in the common case, so this is present
  // from the first paint. Driving the stepper off this instead of the run's own
  // materialized log steps is what keeps "Step 2 of 8" honest when the run has
  // only reached its second step — the log alone only ever knows about steps
  // that have already started (CL-4285).
  catalogSteps: readonly WorkflowFlowStep[] | undefined;
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
  catalogSteps,
  onRespond,
  onClose,
}: WorkflowRunBlocksProps) {
  const reduceMotion = useReducedMotion();
  const steps = useMemo(() => [...state.steps.values()], [state]);
  const activeStep = useMemo(() => deriveActiveStep(steps), [steps]);
  const activeIndex = activeStep
    ? steps.findIndex((s) => s.stepId === activeStep.stepId) + 1
    : null;

  // The full display sequence, one DisplayStep per catalog entry. `s.id` is
  // only the entry's display key — for a declared DISPLAY_STEPS group (e.g.
  // "gather") it is a SYNTHETIC label, never itself a runtime step id, so a
  // step's phase must be read from `s.stepIds` (the real runtime ids the group
  // clusters), not `[s.id]` — otherwise a grouped, Panel-less kind (e.g.
  // prospect-engine) would never match any RunState step and the active index
  // would freeze at 0 for the whole run (CL-4285 follow-up). Absent only
  // during the catalog's initial load.
  const fullSteps: DisplayStep[] | null = useMemo(() => {
    if (catalogSteps === undefined || catalogSteps.length === 0) return null;
    return catalogSteps.map((s) => ({
      key: s.id,
      label: s.title,
      stepIds: s.stepIds,
    }));
  }, [catalogSteps]);

  const fullStepperSteps = useMemo(
    () => (fullSteps ? buildRunStepperSteps(state, fullSteps) : null),
    [fullSteps, state],
  );

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

  // The full sequence, when known, is the authoritative count and label — never
  // "Step 2 of 2" on an 8-step workflow just because only two steps have
  // materialized in the log so far.
  const fullActiveIdx = fullSteps
    ? activeDisplayStepIndex(state, fullSteps)
    : null;
  const headerSubtitle =
    fullSteps && fullActiveIdx !== null
      ? `Step ${String(fullActiveIdx + 1)} of ${String(fullSteps.length)} · ${fullSteps[fullActiveIdx]?.label ?? ""}`
      : activeStep && activeIndex !== null
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
      {fullStepperSteps && (
        <div className="shrink-0 overflow-x-auto">
          <HorizontalStepper steps={fullStepperSteps} />
        </div>
      )}
      <div
        role="status"
        aria-live="polite"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="min-w-0 truncate text-[12px] text-text-3">
            {headerSubtitle}
          </p>
          <span
            className={`shrink-0 text-[12px] font-medium ${awaitingGate ? "text-orange" : "text-text-2"}`}
          >
            {phaseLabel}
          </span>
        </div>
        <AnimatePresence initial={false}>
          {blocks.map((block, index) => (
            <motion.div
              key={blockKey(block, index)}
              {...(reduceMotion === true
                ? {}
                : {
                    initial: { opacity: 0 },
                    animate: { opacity: 1 },
                    exit: { opacity: 0 },
                    transition: { duration: 0.2 },
                  })}
            >
              <UIBlockView block={block} onRespond={onRespond} />
            </motion.div>
          ))}
        </AnimatePresence>

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
          <div className="space-y-2">
            <p className="text-[13px] text-text-3">Waiting for run activity…</p>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
      </div>
    </div>
  );
}
