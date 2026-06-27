import {
  resumeFromLog,
  type BlobSubstrate,
  type WorkflowEvent,
} from "@intx/workflow";

// WORKBENCH-LOCAL (CL-2535): host-satisfied awaitSignal resume.
//
// When the sidecar restarts, a multi-step run parked at an `awaitSignal`
// gate loses its in-process supervisor. Interchange's runtime declines to
// resume such a seed log on its own — `runtimeRun` throws
// `RuntimeResumeUnsupportedError` for a tail in `awaiting-signal` /
// `awaiting-timer` / `in-flight` — and by design delegates recovery to the
// host/substrate (see `runtime/run.ts` + `runtime/dag.ts` comments: "the
// host (supervisor) owns the recovery decision … commit signals and timers
// on the workflow process's behalf"). We own that host layer.
//
// The runtime DOES resume a log whose tail sits on a `completed` step. So
// instead of re-arming the in-process signal channel, we COMPLETE the gate
// from the durable signal — exactly what the runtime body does on the
// non-restart path (`run.ts` `runAwaitSignal`): append `SignalReceived`
// (gate -> in-flight) followed by `StepCompleted` with the signal payload as
// the step output (gate -> completed). `runtimeRun` then re-applies the seed,
// sees a completed gate, and schedules the downstream DAG to `RunCompleted`.
//
// Invariants this preserves (see the run.ts resume guards):
//   - seq is strictly increasing from the log tail (no same-seq collision);
//   - the `StepCompleted.output.ref` is materialized through the SAME blob
//     substrate the resumed `runtimeRun` reads, so downstream
//     `steps.<gate>.output` selectors resolve;
//   - the append must complete before `runtimeRun` starts (single-writer).

export interface DeliveredSignal {
  signalName: string;
  signalId: string;
  payload: unknown;
}

export interface HostSatisfyAwaitSignalOpts {
  runId: string;
  /** The parked run's full event log (tail = `SignalAwaited` for the gate). */
  log: readonly WorkflowEvent[];
  /** The signal the hub delivered for the gate. */
  signal: DeliveredSignal;
  /** Must be the same substrate the resumed `runtimeRun` reads. */
  blobs: BlobSubstrate;
  now?: () => Date;
}

/**
 * Satisfy a gate from a FRESHLY-delivered signal: locate the step in
 * `awaiting-signal` phase and append `SignalReceived` + `StepCompleted`,
 * driving it to `completed`. Hand the result to `runtimeRun({ resumeFromEvents })`.
 *
 * NOT interchangeable with `recoverParkedRunFromLog`: this expects the gate to
 * still be `awaiting-signal` (no signal yet committed) and supplies the signal
 * itself, whereas `recoverParkedRunFromLog` handles the restart case where the
 * signal is already committed to the log (gate is `in-flight`) and only appends
 * `StepCompleted`. This is the un-wired basis for the CL-2537 live re-arm path
 * (host subscribes to the gate mailbox and satisfies it when the signal lands);
 * it has no production caller yet and is currently exercised only by tests.
 *
 * Throws if no step is awaiting the named signal (caller delivered a signal
 * for a run that is not parked on it — a programming error, not a fallback).
 */
export async function hostSatisfyAwaitSignal(
  opts: HostSatisfyAwaitSignalOpts,
): Promise<WorkflowEvent[]> {
  const { runId, log, signal, blobs } = opts;
  const now = opts.now ?? (() => new Date());

  const state = resumeFromLog(runId, log);

  let gateStepId: string | undefined;
  let attempt = 1;
  for (const [id, step] of state.steps) {
    if (
      step.phase === "awaiting-signal" &&
      step.awaitingSignal?.name === signal.signalName
    ) {
      gateStepId = id;
      attempt = step.currentAttempt;
      break;
    }
  }

  if (gateStepId === undefined) {
    throw new Error(
      `hostSatisfyAwaitSignal: run ${runId} has no step awaiting signal "${signal.signalName}"`,
    );
  }

  const maxSeq = log.reduce((max, event) => Math.max(max, event.seq), 0);
  const at = now().toISOString();
  const { ref } = await blobs.recordOutput(gateStepId, attempt, signal.payload);

  const signalReceived: WorkflowEvent = {
    kind: "SignalReceived",
    seq: maxSeq + 1,
    at,
    signalName: signal.signalName,
    signalId: signal.signalId,
    payload: signal.payload,
  };
  const stepCompleted: WorkflowEvent = {
    kind: "StepCompleted",
    seq: maxSeq + 2,
    at,
    stepId: gateStepId,
    attempt,
    output: { ref },
  };

  return [...log, signalReceived, stepCompleted];
}

// Production recovery used by the workflow-child `recoverParkedRun` hook.
//
// The hub delivers a gate approval by committing `SignalReceived` to the run's
// event log (the signal channel's `deliver`). If the sidecar dies after that
// commit but before the runtime commits `StepCompleted`, the resumed log leaves
// the gate `in-flight` — which the runtime also declines to resume. The signal
// (and its payload) are already durable in the log, so we finish the gate by
// appending the missing `StepCompleted` (payload re-materialized through the
// run's blob substrate) and let `runtimeRun` resume.
//
// Returns `null` when there is no received-but-incomplete gate — e.g. the run
// is still genuinely awaiting a human (tail is `awaiting-signal`, no signal
// delivered; the live re-arm watcher is CL-2537) or it is parked at a
// non-signal primitive. The caller then falls through to the default path.
export async function recoverParkedRunFromLog(opts: {
  log: readonly WorkflowEvent[];
  blobs: BlobSubstrate;
  now?: () => Date;
}): Promise<WorkflowEvent[] | null> {
  const { log, blobs } = opts;
  const now = opts.now ?? (() => new Date());

  const awaitedStepBySignal = new Map<string, string>();
  const attemptByStep = new Map<string, number>();
  const completedSteps = new Set<string>();
  const received: { signalName: string; payload: unknown }[] = [];

  for (const event of log) {
    if (event.kind === "SignalAwaited") {
      // Keyed by signal NAME (last-write-wins). Assumes a signal name maps to
      // one gate per run — the runtime routes signals FIFO by name, and an
      // already-completed earlier gate is filtered out below by completedSteps.
      awaitedStepBySignal.set(event.signalName, event.stepId);
    } else if (event.kind === "StepStarted") {
      attemptByStep.set(event.stepId, event.attempt);
    } else if (event.kind === "StepCompleted") {
      completedSteps.add(event.stepId);
    } else if (event.kind === "SignalReceived") {
      received.push({ signalName: event.signalName, payload: event.payload });
    }
  }

  let seq = log.reduce((max, event) => Math.max(max, event.seq), 0);
  const appended: WorkflowEvent[] = [];
  const handled = new Set<string>();

  for (const signal of received) {
    const stepId = awaitedStepBySignal.get(signal.signalName);
    if (stepId === undefined) continue;
    if (completedSteps.has(stepId) || handled.has(stepId)) continue;
    handled.add(stepId);
    const attempt = attemptByStep.get(stepId) ?? 1;
    const { ref } = await blobs.recordOutput(stepId, attempt, signal.payload);
    seq += 1;
    appended.push({
      kind: "StepCompleted",
      seq,
      at: now().toISOString(),
      stepId,
      attempt,
      output: { ref },
    });
  }

  if (appended.length === 0) return null;
  return [...log, ...appended];
}
