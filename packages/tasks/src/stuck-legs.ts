// Gives up, honestly and out loud, on a hand-off nobody is carrying.
//
// A leg is claimed with a lease so that a host which dies mid-hand-off
// doesn't strand it: the next claimant takes it over once the lease
// passes. But the only thing that ever tries to claim is the settling
// of the leg before it, and that settlement happens once — so a claim
// abandoned after its parent settled has no second claimant coming.
// Left alone, the task stays "running" forever with nothing in the
// person's Inbox to say otherwise.
//
// This sweep is that second look. It mirrors
// `apps/hub/src/credential-expiry-sweep.ts`: a pure `tick…` function a
// test can drive one deterministic pass at a time, a conditional claim
// so two replicas sweeping at once still settle each leg exactly once,
// and an interval wrapper the host starts and stops.
import {
  deliverTaskResultMail,
  type NotifyDeliveryDeps,
} from "@corbits/notify";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";

import { resolveAgentName } from "./orchestrator";
import type { TaskStore } from "./store";

const log = getLogger(["tasks", "stuck-legs"]);

/** What the person reads. Their task stopped; nothing about how. */
export const STUCK_LEG_MESSAGE =
  "The next agent never started, so this task was stopped. Start it again to pick the work back up.";

/**
 * How long past its lease a claimed hand-off must sit before the sweep
 * gives up on it — room for a slow launch that is still going to
 * arrive, well short of a person wondering where their task went.
 */
export const STUCK_LEG_GRACE_MS = 60_000;

export const STUCK_LEG_SWEEP_INTERVAL_MS = 60_000;

export type StuckLegSweepDeps = {
  readonly db: DB["db"];
  readonly store: TaskStore;
  readonly notify: NotifyDeliveryDeps;
  readonly graceMs?: number;
  /** Injectable for deterministic tests; defaults to wall time. */
  readonly now?: () => Date;
};

/**
 * One pass: fail every hand-off that was claimed and never started,
 * fail the task it belongs to, and deliver one plain Inbox item.
 * Exported so a test can drive a single pass without an interval.
 */
export async function tickStuckLegSweep(
  deps: StuckLegSweepDeps,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const claimedBefore = new Date(
    now.getTime() - (deps.graceMs ?? STUCK_LEG_GRACE_MS),
  );
  const stuck = await deps.store.listStuckLegDispatches({ claimedBefore });

  for (const leg of stuck) {
    // Conditional, winner-takes-all: a second replica sweeping the same
    // leg — or the launch finally arriving — takes it first and this
    // pass has nothing to report.
    const failed = await deps.store.failLegDispatch({
      tenantId: leg.tenantId,
      legId: leg.id,
      errorMessage: STUCK_LEG_MESSAGE,
      settledAt: now,
    });
    if (failed === null) continue;

    log.warn`task ${leg.taskId}: hand-off to leg ${String(
      leg.position,
    )} was claimed at ${leg.createdAt.toISOString()} and never started`;

    const record = await deps.store.getTask(leg.tenantId, leg.taskId);
    if (record === null) continue;
    const completed = await deps.store.completeTask({
      tenantId: leg.tenantId,
      id: leg.taskId,
      status: "failed",
      completedAt: now,
    });
    if (completed === null) continue;

    const agentName = await resolveAgentName(
      deps.db,
      record.tenantId,
      record.definitionId,
    );
    const report = await deliverTaskResultMail(deps.notify, {
      kind: "task-result",
      tenantId: record.tenantId,
      taskId: record.id,
      runIds: [...completed.runIds],
      stepCount: completed.stepCount,
      agentName,
      status: "failed",
      errorMessage: STUCK_LEG_MESSAGE,
      elapsedMs: now.getTime() - record.createdAt.getTime(),
      artifacts: [],
      recipients: [
        { tenantId: record.tenantId, principalId: record.principalId },
      ],
      createdAt: now.toISOString(),
    });
    const mailId = report.deliveredMailboxRowIds[0];
    if (mailId !== undefined) {
      await deps.store.recordResultMail({
        tenantId: record.tenantId,
        id: record.id,
        resultMailId: mailId,
      });
    }
  }
}

export function createStuckLegSweep(deps: StuckLegSweepDeps): {
  stop(): void;
} {
  let tickInFlight = false;

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await tickStuckLegSweep(deps);
    } catch (cause) {
      log.error`stuck hand-off sweep failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
    } finally {
      tickInFlight = false;
    }
  }

  const interval = setInterval(() => void tick(), STUCK_LEG_SWEEP_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop(): void {
      clearInterval(interval);
    },
  };
}
