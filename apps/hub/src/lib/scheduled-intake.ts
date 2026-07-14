import { randomUUID } from "node:crypto";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { setPendingSignal } from "../workflow-executor/run-store";
import { validateResumePayload } from "../workflow-executor/resume-payload-registry";

const log = getLogger(["services", "scheduled-intake"]);

// The awaitSignal gate name a scheduled run's stored intake is auto-delivered to
// (CL-3509). Matches the workflow defs' entry `intake` gate; the resume-payload
// registry validates the payload for this signal per kind.
export const INTAKE_SIGNAL_NAME = "intake";

// Trigger-payload keys the server owns (caller identity, injected at attach time).
// They are NOT part of the intake a human supplies, so the intake auto-delivered
// at fire time is the stored trigger payload with these stripped.
export const RESERVED_TRIGGER_PAYLOAD_KEYS = [
  "userAddress",
  "userRefId",
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
  });
  return true;
}
