import { type } from "arktype";
import type { RunPhase, RunState, StepState } from "@intx/workflow";

// Thin run INDEX (CL-2669) as returned by the hub /workflow-exec/records
// endpoints. Run-level identity + coarse `status` only — per-step state and step
// outputs are read from the native event log (see `useWorkflowRunState` and
// `useWorkflowStepOutputs`).
export interface RunRecord {
  runId: string;
  kind: string;
  // `provisioning` (CL-2755): the run's per-run deployment is still cold-starting
  // off the /start critical path. Non-terminal — the FE shows a live "Starting…"
  // state until the projection advances it to `running`.
  status: "provisioning" | "running" | "awaiting" | "completed" | "failed";
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

// True once a native `RunPhase` can no longer advance on its own. Same terminal
// set as `isLogStateTerminal`, typed against the `@intx/workflow` `RunPhase` the
// folded `RunState` carries.
export function isRunPhaseTerminal(phase: RunPhase): boolean {
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

// Resolved step outputs, decoded straight from the run-keyed log fold (CL-2704).
// The substrate stores any output whose JSON is <= 1 MiB as an `inline:` ref —
// `"inline:" + JSON.stringify(output)` — so the /state response already carries
// the content and the client decodes it without a second request. This replaces
// the legacy deployment-keyed /workflow-runs/:deploymentId/steps read, which
// 404s under per-run deployments (CL-2582). `blob:` refs (> 1 MiB outputs) are
// not client-resolvable and are omitted — a bridge limitation superseded by
// CL-2684/CL-2665.
const INLINE_REF_PREFIX = "inline:";

export function stepOutputsFromLog(log: LogRunState): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const s of log.steps) {
    if (s.outputRef === undefined) continue;
    if (!s.outputRef.startsWith(INLINE_REF_PREFIX)) continue;
    // Per-step catch: a single malformed inline blob must poison only its own
    // step. A whole-run catch discards every decoded sibling and mislabels valid
    // steps as "stored out of line". A step that fails to decode is simply
    // omitted — its raw `outputRef` still renders the honest note.
    try {
      outputs[s.stepId] = JSON.parse(
        s.outputRef.slice(INLINE_REF_PREFIX.length),
      );
    } catch {
      continue;
    }
  }
  return outputs;
}

// Map the thin index status to a run-level `RunPhase` for the log-unavailable
// fallback. `awaiting` (parked on a gate) is still live, so it maps to
// `running` — the run has not settled.
function recordStatusToPhase(status: RunRecord["status"]): RunPhase {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "running";
}

// Minimal RunState synthesized from the thin run INDEX alone, for when the log
// is unavailable (a legacy run with no `deploymentId`, a 400, or a read error).
// It carries no per-step detail — the log is the only source of that — but a
// legible run-level phase so the pane renders a terminal/failed/empty state
// instead of hanging forever on "Loading run…".
export function runStateFromRecord(record: RunRecord): RunState {
  return {
    runId: record.runId,
    phase: recordStatusToPhase(record.status),
    lastSeq: 0,
    steps: new Map(),
    children: new Map(),
    pendingTimers: new Map(),
    observedSignalIds: new Set(),
    unconsumedSignals: new Map(),
    consumedMessageIds: new Set(),
  };
}

// Reconcile the run-level INDEX status with the log-derived per-step state. The
// index is authoritative for run-level TERMINAL: an operator abort or a
// restart-reconcile writes `failed` only to the index, never to the log — the
// log's last event is a `StepStarted`, so the fold yields a non-terminal
// `running` phase with a step stuck in-flight. Overlay the index's terminal
// phase so the run renders failed, while the log still drives WHICH step it died
// on (per-step detail is preserved unchanged). When neither is terminal, or the
// log already agrees, the log state passes through untouched.
export function reconcileRunState(record: RunRecord, log: RunState): RunState {
  if (!isRecordTerminal(record.status)) return log;
  if (isRunPhaseTerminal(log.phase)) return log;
  return { ...log, phase: recordStatusToPhase(record.status) };
}

// A run the index marks terminal-`failed` while its log is still non-terminal
// was killed externally (operator abort / restart reconcile) — the log never
// recorded a `RunFailed`. This distinguishes an interruption (surface an
// "interrupted" affordance) from a genuine step failure, which writes `failed`
// to the log too.
export function runWasInterrupted(
  record: RunRecord,
  logPhase: RunPhase,
): boolean {
  return record.status === "failed" && !isRunPhaseTerminal(logPhase);
}
