/**
 * HITL signal-routing contract (CL-2681).
 *
 * A workflow parks on an `awaitSignal` gate; a human decision reaches it by
 * POSTing `{ signalName, payload }` to the run's resume route. Which gate a
 * decision is FOR is derived here — never hardcoded in a renderer — from the
 * run's log-derived state, whose awaiting step carries `awaitingSignalName`
 * (populated by the hub's run-state fold; see run-state-from-log.ts).
 *
 * The rule spans a whole conversation (its set of runs):
 *   - exactly one pending gate  → free text auto-routes to it
 *   - zero pending gates        → free text is a normal chat turn
 *   - more than one pending gate → free text does NOT auto-route; the human
 *     must use a run's card button or name the run (multi-gate disambiguation)
 *
 * This module is UI-agnostic and shared by the chat prompt-box routing and the
 * dock card affordance so the derivation lives in one reusable place — CL-2682
 * (run-addressed events into Myra's thread) pairs with the multi-gate rule.
 */

// The minimal per-step shape this derivation reads. A superset of the fields on
// the log-derived run state (`awaitingSignalName` is present only while a step
// is parked on a gate), so a run's `LogRunState.steps` satisfies it directly.
export interface GateStepInput {
  phase:
    | "in-flight"
    | "awaiting-signal"
    | "awaiting-timer"
    | "completed"
    | "failed"
    | "cancelled";
  awaitingSignalName?: string | undefined;
}

/**
 * A run parked on a resolvable `awaitSignal` gate. `runKind` is the workflow
 * kind for multi-gate disambiguation display; it is optional because the dock
 * card path resolves a single run's gate purely for its `signalName` and has no
 * kind to pass — only the conversation-level scan (which lists the runs) does.
 */
export interface PendingGate {
  runId: string;
  runKind?: string;
  signalName: string;
}

/**
 * The pending gate for a single run, or null. A gate is resolvable only when a
 * step is `awaiting-signal` AND the fold recovered its `awaitingSignalName` — a
 * gate whose name is unknown cannot be routed to and is deliberately not
 * returned (the renderer never invents a signal). Returns the first such step;
 * a run parks on at most one gate at a time in the linear workflows shipped
 * today (independent-branch concurrency would surface multiple, handled by the
 * conversation-level multi rule).
 */
export function pendingGateForRun(run: {
  runId: string;
  runKind?: string;
  steps: readonly GateStepInput[];
}): PendingGate | null {
  for (const step of run.steps) {
    if (step.phase !== "awaiting-signal") continue;
    if (step.awaitingSignalName === undefined) continue;
    return {
      runId: run.runId,
      ...(run.runKind !== undefined ? { runKind: run.runKind } : {}),
      signalName: step.awaitingSignalName,
    };
  }
  return null;
}

/**
 * The routing verdict for a conversation's pending gates. `single` carries the
 * one gate free text auto-routes to; `multi` carries every pending gate so the
 * UI can make which-is-which obvious and require an explicit target.
 */
export type SignalRouting =
  | { mode: "none" }
  | { mode: "single"; gate: PendingGate }
  | { mode: "multi"; gates: PendingGate[] };

export function routeConversationSignal(
  gates: readonly PendingGate[],
): SignalRouting {
  if (gates.length === 0) return { mode: "none" };
  if (gates.length === 1) return { mode: "single", gate: gates[0]! };
  return { mode: "multi", gates: [...gates] };
}
