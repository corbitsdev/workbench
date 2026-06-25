import type { RunPhase, RunState, StepPhase, StepState } from "@intx/workflow";

// Thin-executor run record (CL-2240) as returned by the hub
// /workflow-exec/records endpoints. `outputs` is the stepId -> output envelope
// map; `currentStepId` plus `status` identify the active gate. This replaces the
// old SSE event-log model — there is no per-event `phase`, so the adapter below
// synthesizes the @intx/workflow `RunState` shape the panels already consume.
export interface RunRecord {
  runId: string;
  kind: string;
  status: "running" | "awaiting" | "completed" | "failed";
  currentStepId: string | null;
  outputs: Record<string, unknown>;
  error?: string;
  // The deployment that produced this run (CL-2321) — used to resolve the exact
  // deployed version, not the newest deployment of the kind. Absent on runs
  // created before the record began persisting it.
  deploymentId?: string;
}

const RECORD_TO_RUN_PHASE: Record<RunRecord["status"], RunPhase> = {
  running: "running",
  awaiting: "running",
  completed: "completed",
  failed: "failed",
};

// True once the run can no longer advance on its own — the caller stops polling
// and gates signal/resume actions. `awaiting` is NOT terminal: the run is parked
// on a human-input gate and resumes when the panel posts a signal.
export function isRecordTerminal(status: RunRecord["status"]): boolean {
  return status === "completed" || status === "failed";
}

// Synthesize the @intx/workflow RunState the panels read. Every stepId present
// in `outputs` is a completed step (its envelope is exposed via outputRef so the
// host surfaces it in stepOutputs). The active step is `currentStepId`: parked on
// a signal gate when status is 'awaiting', otherwise running. On a failed run the
// active step carries the failure so the panel's hasFailed() detects it.
//
// We deliberately back the rich RunState with the lean record rather than
// changing every panel to read currentStepId/status directly: the panels' cluster
// -> display-index logic (activeDisplayIndex, phaseFor, isActive) is ~250 lines of
// per-step phase reasoning that all keeps working unchanged when fed a synthesized
// state, so this is the lower-churn, lower-risk seam.
export function runStateFromRecord(record: RunRecord): RunState {
  const steps = new Map<string, StepState>();

  for (const stepId of Object.keys(record.outputs)) {
    steps.set(stepId, {
      stepId,
      phase: "completed",
      currentAttempt: 1,
      outputRef: `record:${stepId}`,
    });
  }

  const activeId = record.currentStepId;
  if (activeId !== null && !steps.has(activeId)) {
    let phase: StepPhase = "in-flight";
    if (record.status === "awaiting") phase = "awaiting-signal";
    if (record.status === "failed") phase = "failed";
    const step: StepState = {
      stepId: activeId,
      phase,
      currentAttempt: 1,
      // The record does not surface the gate's expected signalName, so the
      // generic RunConsole fallback uses the stepId as its best guess. Custom
      // panels (every shipped kind has one) hardcode the correct signal name and
      // never read this field — RunConsole is the only consumer.
      ...(phase === "awaiting-signal"
        ? { awaitingSignal: { name: activeId } }
        : {}),
      ...(record.error !== undefined
        ? { lastError: { message: record.error } }
        : {}),
    };
    steps.set(activeId, step);
  }

  return {
    runId: record.runId,
    phase: RECORD_TO_RUN_PHASE[record.status],
    lastSeq: steps.size,
    steps,
    children: new Map(),
    pendingTimers: new Map(),
    observedSignalIds: new Set(),
    unconsumedSignals: new Map(),
    consumedMessageIds: new Set(),
  } as RunState;
}
