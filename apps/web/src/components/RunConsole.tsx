import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button, classifyRunError, toHumanLabel } from "@workbench/ui";
import { WorkflowStartingIndicator } from "./WorkflowStartingIndicator";
import type { RunPhase, RunState, StepPhase, StepState } from "@intx/workflow";
import {
  isRecordTerminal,
  reconcileRunState,
  runStateFromLog,
  runStateFromRecord,
  runWasInterrupted,
  useResumeWorkflow,
  useWorkflowRecord,
  useWorkflowRunState,
} from "../hooks/use-workflow";

const RUN_PHASE_LABELS: Record<RunPhase, string> = {
  pending: "Pending",
  running: "Running",
  cancelling: "Cancelling",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STEP_PHASE_LABELS: Record<StepPhase, string> = {
  "in-flight": "In flight",
  "awaiting-signal": "Awaiting approval",
  "awaiting-timer": "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STEP_PHASE_DOT: Record<StepPhase, string> = {
  "in-flight": "bg-orange",
  "awaiting-signal": "bg-orange",
  "awaiting-timer": "bg-orange",
  completed: "bg-green-500",
  failed: "bg-red-500",
  cancelled: "bg-border-strong",
};

interface RunConsoleProps {
  deploymentId: string;
  tenantId?: string | null;
  onClose: () => void;
}

// Derives the active step for the panel header. The active step is the first
// step that is in-flight or awaiting a signal/timer; if there is none (all
// done), it is the first non-completed step; else the last step overall.
function deriveActiveStep(state: RunState): StepState | null {
  const steps = [...state.steps.values()];
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

// Generic workflow-run console driven entirely by the native run stream. It
// reduces the streamed WorkflowEvent log into RunState and renders run phase,
// a step timeline, step outputs, and an Approve action for any step blocked on
// a signal (the HITL gate). No workflow-kind-specific branching lives here.
export function RunConsole({
  deploymentId,
  tenantId,
  onClose,
}: RunConsoleProps) {
  const reduceMotion = useReducedMotion();
  // Guard falsy id so no record query fires against an empty runId.
  const safeId = deploymentId || null;
  const { data: record, isLoading } = useWorkflowRecord(safeId, tenantId);
  const { data: logState, isError: logError } = useWorkflowRunState(
    safeId,
    tenantId,
  );
  const resume = useResumeWorkflow(deploymentId, tenantId);

  // The timeline's per-step source of truth is the log-derived run state
  // (CL-2669), reconciled with the run-level index status: an aborted or
  // restart-interrupted run is `failed` in the index but non-terminal in the log
  // (last event a StepStarted), so the overlay renders it failed while the log
  // still drives which step it died on. When the log is unavailable (legacy run
  // with no deploymentId, or a read error), fall back to the record-derived
  // run-level state so a terminal run renders instead of hanging.
  const state = useMemo<RunState | null>(() => {
    if (!record) return null;
    if (logState) return reconcileRunState(record, runStateFromLog(logState));
    if (logError || record.deploymentId === undefined)
      return runStateFromRecord(record);
    return null;
  }, [record, logState, logError]);

  // True only when the index says failed but the log is still non-terminal —
  // the run was killed externally, not a genuine step failure.
  const interrupted =
    record !== undefined &&
    logState !== undefined &&
    runWasInterrupted(record, logState.phase);
  const settled = !isLoading;
  const connected =
    record?.status === "running" || record?.status === "awaiting";

  const terminal = record !== undefined && isRecordTerminal(record.status);
  const steps = useMemo<StepState[]>(
    () => (state ? [...state.steps.values()] : []),
    [state],
  );
  const activeStep = useMemo(
    () => (state ? deriveActiveStep(state) : null),
    [state],
  );
  const stepCount = steps.length;
  const activeIndex = activeStep
    ? steps.findIndex((s) => s.stepId === activeStep.stepId) + 1
    : null;

  // CL-2755: while the run's per-run deployment is still cold-starting
  // (`provisioning`), show a live "Starting…" state WITH motion instead of the
  // static "No steps have started yet." — a provisioning run must never look
  // frozen.
  if (record?.status === "provisioning") {
    return (
      <div className="flex h-full flex-col overflow-hidden border border-border bg-bg">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-medium text-text">
              Workflow run
            </p>
            <p className="truncate text-[12px] text-text-3">Starting…</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className="min-h-0 flex-1">
          <WorkflowStartingIndicator variant="pane" />
        </div>
      </div>
    );
  }

  // Bug fix (1): show a stable "Loading run…" until the initial backlog flush
  // has settled, to avoid animating through historical steps in the header.
  const headerSubtitle = !settled
    ? "Loading run…"
    : activeStep && activeIndex !== null
      ? `Step ${String(activeIndex)} of ${String(stepCount)} · ${toHumanLabel(activeStep.stepId)}`
      : (deploymentId ?? "");

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
          {state && (
            <span className="text-[12px] font-medium text-text-2">
              {RUN_PHASE_LABELS[state.phase]}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {/* CL-2781: crossfade the coarse body phase (loading → waiting → content)
            so the provisioning/loading → first streamed frame doesn't hard-cut a
            full layout swap. Reduced motion collapses it to an instant show. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={!settled ? "loading" : !state ? "waiting" : "content"}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
          >
            {!settled && (
              <p className="text-[13px] text-text-3">Loading run…</p>
            )}
            {settled && !state && (
              <p className="text-[13px] text-text-3">
                {connected ? "Waiting for run activity…" : "Connecting…"}
              </p>
            )}
            {settled &&
              state &&
              terminal &&
              state.phase === "failed" &&
              interrupted && (
                <div className="flex flex-col items-start gap-3">
                  <p className="text-[13px] text-text-3">
                    This run was interrupted and can't continue. Start a new run
                    to pick up where you left off.
                  </p>
                  <Button variant="primary" size="sm" onClick={onClose}>
                    Start a new run
                  </Button>
                </div>
              )}
            {settled &&
              state &&
              terminal &&
              state.phase === "failed" &&
              !interrupted && (
                <p className="text-[13px] text-text-3">
                  This run failed. Start a new run to try again.
                </p>
              )}
            {settled && state && steps.length === 0 && !terminal && (
              <p className="text-[13px] text-text-3">
                No steps have started yet.
              </p>
            )}
            {settled && state && steps.length > 0 && (
              <ol className="flex flex-col gap-3">
                {steps.map((step) => (
                  <RunStepRow
                    key={step.stepId}
                    step={step}
                    runState={state}
                    // Bug fix (2): never fire a signal when the run is terminal.
                    onApprove={
                      terminal
                        ? () => undefined
                        : (signalName) =>
                            resume
                              .mutateAsync({
                                signalName,
                                payload: { approved: true },
                              })
                              .catch(() => undefined)
                    }
                    approving={resume.isPending && !terminal}
                  />
                ))}
              </ol>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function RunStepRow({
  step,
  runState,
  onApprove,
  approving,
}: {
  step: StepState;
  runState: RunState;
  onApprove: (signalName: string) => void;
  approving: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const awaitingSignal =
    step.phase === "awaiting-signal" ? step.awaitingSignal : undefined;
  return (
    <li className="rounded-[10px] border border-border bg-surface px-3 py-3 transition-colors duration-200">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* CL-2781: transition-colors so the phase dot eases between states
              instead of hard-cutting as live SSE frames arrive. */}
          <span
            className={`h-2 w-2 shrink-0 rounded-full transition-colors duration-200 ease-out ${STEP_PHASE_DOT[step.phase]}`}
          />
          <span className="truncate text-[13px] font-medium text-text">
            {toHumanLabel(step.stepId)}
          </span>
        </div>
        {/* CL-2781: crossfade the phase label on swap rather than snapping text. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={step.phase}
            className="shrink-0 text-[12px] text-text-3"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.15, ease: "easeOut" }}
          >
            {STEP_PHASE_LABELS[step.phase]}
          </motion.span>
        </AnimatePresence>
      </div>

      {step.lastError && (
        <p className="mt-2 text-[12px] text-red-500">
          {classifyRunError(step.lastError.message).userMessage}
        </p>
      )}

      {step.outputRef && (
        <p className="mt-2 break-all text-[12px] text-text-2">
          Output: {step.outputRef}
        </p>
      )}

      {awaitingSignal && runState.phase === "running" && (
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={approving}
            onClick={() => onApprove(awaitingSignal.name)}
          >
            {approving ? "Approving…" : "Approve"}
          </Button>
          <span className="text-[12px] text-text-3">
            Signal: {awaitingSignal.name}
          </span>
        </div>
      )}
    </li>
  );
}
