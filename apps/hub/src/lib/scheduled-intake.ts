import { randomUUID } from "node:crypto";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { setPendingSignal } from "../workflow-executor/run-store";
import { validateResumePayload } from "../workflow-executor/resume-payload-registry";
import { loadWorkflowGateInfos } from "./workflow-catalog";
import type { WorkflowGateInfo } from "./workflow-gate-info";

const log = getLogger(["services", "scheduled-intake"]);

// The awaitSignal gate name a scheduled run's stored intake is auto-delivered to
// (CL-3509). Matches the workflow defs' entry `intake` gate; the resume-payload
// registry validates the payload for this signal per kind.
export const INTAKE_SIGNAL_NAME = "intake";

// Trigger-payload keys the server owns (caller identity, or the runId stamped
// onto every trigger payload at start time — CL-4548). They are NOT part of the
// intake a human supplies, so the intake auto-delivered is the trigger payload
// with these stripped, whichever door started the run.
export const RESERVED_TRIGGER_PAYLOAD_KEYS = [
  "userAddress",
  "userRefId",
  "runId",
] as const;

// The intake payload to auto-deliver: the stored trigger payload minus the
// server-owned identity keys. Empty when the schedule carries no intake fields.
export function extractStoredIntake(
  triggerPayload: Record<string, unknown>,
): Record<string, unknown> {
  const reserved = new Set<string>(RESERVED_TRIGGER_PAYLOAD_KEYS);
  return Object.fromEntries(
    Object.entries(triggerPayload).filter(([key]) => !reserved.has(key)),
  );
}

// Queue the stored intake as a durable pending `intake` signal on a freshly
// started scheduled run (CL-3509). The run has just been triggered and will park
// on its `intake` gate; the awaiting reconciler's pending-signal pass delivers
// this signal once the supervisor is routable and re-delivers until the run log
// proves receipt — the same durable rail a human gate-resume uses, so scheduled
// runs pass the first gate without a human. Validates the payload against the
// kind's registered intake schema first; an invalid or empty stored intake is NOT
// queued (logged when invalid) so the run parks and the stalled-run reconciler
// fails it legibly rather than delivering a payload the boundary would reject.
// Returns whether a signal was queued.
export async function queueScheduledIntakeSignal(
  db: HubDb,
  args: { runId: string; kind: string; intake: Record<string, unknown> },
): Promise<boolean> {
  if (Object.keys(args.intake).length === 0) return false;
  const check = validateResumePayload(
    args.kind,
    INTAKE_SIGNAL_NAME,
    args.intake,
  );
  if (!check.ok) {
    log.error("scheduled intake payload invalid; not auto-delivering", {
      runId: args.runId,
      kind: args.kind,
      problem: check.error,
    });
    return false;
  }
  await setPendingSignal(db, args.runId, {
    signalId: randomUUID(),
    signalName: INTAKE_SIGNAL_NAME,
    payload: args.intake,
    receivedAt: new Date().toISOString(),
    // Explicit `false` — this is the ONLY writer of a queued-only row (see
    // pending-signal.ts): nothing has been dispatched yet, so the reconciler's
    // next pass is the genuine first delivery and must skip the backoff.
    // Absent means "dispatched" (the pre-existing acceptGateSignal/
    // resumeWorkflowRun rows), so this key must be written, not omitted.
    dispatched: false,
  });
  return true;
}

// Memoized for the process lifetime: `loadWorkflowGateInfos()` reads the
// build-time-embedded, committed workflow-defs directory (readdir + JSON.parse
// per def), which cannot change without a redeploy — the same assumption the
// former boot-time `const schedulerGateInfos = await loadWorkflowGateInfos()`
// in index.ts relied on. `deliverStartIntakeSignal` is now on BOTH the
// scheduler and manual-start hot paths, so re-reading the whole embedded
// catalog from disk on every call (as opposed to that former one-time read)
// is an avoidable per-run cost; caching restores the boot-time-read behavior
// without threading the map through both callers as an explicit dependency.
let cachedGateInfos: Promise<Map<string, WorkflowGateInfo>> | undefined;
function loadWorkflowGateInfosCached(): Promise<Map<string, WorkflowGateInfo>> {
  cachedGateInfos ??= loadWorkflowGateInfos();
  return cachedGateInfos;
}

// Shared post-start intake delivery for EVERY run-start door (scheduler fire
// and manual "start now"), so a freshly started run of an intake-gated kind
// passes its first gate without asking a human twice for what they just typed
// (CL-4548 — a manual start had no equivalent of the scheduler's auto-deliver
// and re-asked for the same trigger payload it was just given). Looks up the
// kind's gate shape itself so callers do not need to thread `requiresIntake`
// through; kinds whose entry gate is not named `intake` are left untouched —
// the run parks and asks, which is correct for those. An empty or
// schema-invalid trigger payload is also left undelivered (see
// `queueScheduledIntakeSignal`): the run parks and the human completes it,
// rather than the run failing loudly mid-flight on a payload the boundary
// would reject. Returns whether a signal was queued.
export async function deliverStartIntakeSignal(
  db: HubDb,
  args: {
    runId: string;
    kind: string;
    triggerPayload: Record<string, unknown>;
  },
): Promise<boolean> {
  const gateInfos = await loadWorkflowGateInfosCached();
  if (gateInfos.get(args.kind)?.requiresIntake !== true) return false;
  const intake = extractStoredIntake(args.triggerPayload);
  return queueScheduledIntakeSignal(db, {
    runId: args.runId,
    kind: args.kind,
    intake,
  });
}
