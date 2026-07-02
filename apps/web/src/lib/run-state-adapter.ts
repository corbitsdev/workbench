import { type } from "arktype";
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

// Log-derived run state (CL-2669 Phase 1b). Mirror of the hub's
// `LogRunStateSchema` (apps/hub/src/workflow-executor/run-state-from-log.ts) —
// the two build graphs make a literal import non-trivial, so the boundary schema
// is redefined here and every response is parsed through it. This is the
// authoritative per-step state the runtime itself computes from the append-only
// git event log, replacing the coarse `workflow_run_record` projection as the
// stepper's source of truth: a failed step reads `failed` (not synthesized from
// a lagging record), an awaiting gate reads `awaiting-signal` by construction.
export const logStepStateSchema = type({
  stepId: "string",
  phase:
    "'in-flight'|'awaiting-signal'|'awaiting-timer'|'completed'|'failed'|'cancelled'",
  stepType: "'human'|'agent'|'deterministic'|'inline'|'other'|'unknown'",
  currentAttempt: "number",
  "outputRef?": "string",
  "lastError?": { message: "string" },
  "awaitingSignalName?": "string",
  "startedAt?": "string",
  "endedAt?": "string",
});
export type LogStepState = typeof logStepStateSchema.infer;

export const logRunStateSchema = type({
  runId: "string",
  phase: "'pending'|'running'|'cancelling'|'completed'|'failed'|'cancelled'",
  "definitionHash?": "string",
  lastSeq: "number",
  "startedAt?": "string",
  "endedAt?": "string",
  steps: logStepStateSchema.array(),
});
export type LogRunState = typeof logRunStateSchema.infer;

// True once the run can no longer advance on its own. Mirrors the native
// `isTerminalRunPhase` — a `cancelled` run is terminal too (the record model
// never produced that phase; the log does).
export function isLogStateTerminal(phase: LogRunState["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

// Fold the log-derived state onto the @intx/workflow `RunState` the panels and
// the shared stepper (packages/ui/workflow-run-state.tsx) already consume. Every
// per-step phase is carried through verbatim — nothing is synthesized — so the
// stepper renders exactly the phase the runtime recorded: `failed` steps render
// failed, `awaiting-signal` steps render as the active gate. The panels read the
// step *content* from the record's `outputs` map (passed separately as
// `stepOutputs`); this state drives only phase/routing, so `outputRef` is carried
// through for completeness but is not the content lookup key.
export function runStateFromLog(log: LogRunState): RunState {
  const steps = new Map<string, StepState>();
  for (const s of log.steps) {
    const step: StepState = {
      stepId: s.stepId,
      phase: s.phase,
      currentAttempt: s.currentAttempt,
      ...(s.outputRef !== undefined ? { outputRef: s.outputRef } : {}),
      ...(s.lastError !== undefined
        ? { lastError: { message: s.lastError.message } }
        : {}),
      ...(s.awaitingSignalName !== undefined
        ? { awaitingSignal: { name: s.awaitingSignalName } }
        : {}),
    };
    steps.set(s.stepId, step);
  }
  return {
    runId: log.runId,
    phase: log.phase,
    ...(log.definitionHash !== undefined
      ? { definitionHash: log.definitionHash }
      : {}),
    lastSeq: log.lastSeq,
    steps,
    children: new Map(),
    pendingTimers: new Map(),
    observedSignalIds: new Set(),
    unconsumedSignals: new Map(),
    consumedMessageIds: new Set(),
  };
}
