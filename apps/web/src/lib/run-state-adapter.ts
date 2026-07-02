import { type } from "arktype";
import type { RunState, StepState } from "@intx/workflow";

// Thin run INDEX (CL-2669) as returned by the hub /workflow-exec/records
// endpoints. Run-level identity + coarse `status` only — per-step state and step
// outputs are read from the native event log (see `useWorkflowRunState` and
// `useWorkflowStepOutputs`).
export interface RunRecord {
  runId: string;
  kind: string;
  status: "running" | "awaiting" | "completed" | "failed";
  // The deployment that produced this run (CL-2321) — used to resolve the exact
  // deployed version and to read the run's event log / step outputs. Absent on
  // runs created before the record began persisting it.
  deploymentId?: string;
}

// True once the run can no longer advance on its own — the caller stops polling
// and gates signal/resume actions. `awaiting` is NOT terminal: the run is parked
// on a human-input gate and resumes when the panel posts a signal.
export function isRecordTerminal(status: RunRecord["status"]): boolean {
  return status === "completed" || status === "failed";
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
