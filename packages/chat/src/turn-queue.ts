// One in-flight turn per workbench (CL-6331): a burst of messages
// arriving for the same workbench while a turn is already running must
// queue rather than dispatch concurrently, and — Buzz's rule — every
// message that queued behind one in-flight turn dispatches together as
// ONE next turn, in arrival order, rather than each replaying its own
// separate dispatch once the claim frees up.
//
// "Turn" here means what `dispatchTurn` (`./workbench-service.ts`) can
// actually observe: the fan-out for one incoming message, to however
// many recipients it resolves to. `dispatchTurn` itself only reaches
// "the mail was handed to the agent's mailbox" — the agent's real
// processing happens later, off this call stack, and lands back on the
// timeline through the orchestrator (CL-6329, not yet built). So
// "release on completion" below means "release once this seam's own
// dispatch call settles", not "once the agent finished replying" —
// exactly the gap `./turn-claims.ts`'s TTL exists to backstop.
import { type } from "arktype";

import type { Part as PartType } from "./parts";
import type { TurnClaimStore } from "./turn-claims";
import type { WorkbenchSubscriberRegistry } from "./workbench-events";

/**
 * The non-persisted stream event a room's client renders as the queued
 * strip. Never written to the timeline — a queued message's own
 * message row already carries it there; this is only the live signal
 * that its turn is waiting, not what it says.
 */
export const TurnQueuedEvent = type({
  type: "'chat.turn-queued'",
  data: {
    workbenchId: "string",
    messageId: "string",
    queueLength: "number",
  },
});
export type TurnQueuedEvent = typeof TurnQueuedEvent.infer;

export type QueuedTurn = {
  readonly messageId: string;
  readonly principalId: string;
  readonly recipients: readonly string[];
  readonly parts: readonly PartType[];
};

export type WorkbenchTurnQueueDeps = {
  readonly claims: TurnClaimStore;
  readonly publish: WorkbenchSubscriberRegistry["publish"];
};

/**
 * Dispatches one turn's worth of (possibly batched) recipients. Must
 * never reject — exactly like `routeMessage`'s own contract in
 * `workbench-service.ts`, which this wraps: a recipient that fails is
 * `dispatch`'s own job to report (an undelivered notice on the
 * timeline), never something this queue has to catch. A `dispatch` that
 * broke this contract would strand whatever queued behind it — the
 * claim still releases (see `run`'s `finally`), but nothing would be
 * left to notice and drain the leftover queue until the next unrelated
 * message arrived.
 */
export type DispatchTurnBatch = (batch: readonly QueuedTurn[]) => Promise<void>;

export type WorkbenchTurnQueue = {
  /**
   * Runs `turn` as this workbench's in-flight turn if none is
   * currently claimed, via `dispatch`. Otherwise queues `turn` behind
   * whichever turn is running and publishes `chat.turn-queued` so the
   * room can render the queued strip; the queued turn dispatches later,
   * batched with whatever else queued alongside it, once the in-flight
   * turn's claim releases. Never rejects: queueing always succeeds, and
   * `dispatch`'s own failure is `dispatch`'s to report (see
   * `dispatchTurn`'s per-recipient handling in `workbench-service.ts`).
   */
  run(
    workbenchId: string,
    turn: QueuedTurn,
    dispatch: DispatchTurnBatch,
  ): Promise<void>;
};

export function createWorkbenchTurnQueue(
  deps: WorkbenchTurnQueueDeps,
): WorkbenchTurnQueue {
  const pendingByWorkbench = new Map<string, QueuedTurn[]>();

  return {
    async run(workbenchId, turn, dispatch) {
      const claimed = await deps.claims.tryClaim({ workbenchId });
      if (!claimed) {
        const queue = pendingByWorkbench.get(workbenchId) ?? [];
        queue.push(turn);
        pendingByWorkbench.set(workbenchId, queue);
        deps.publish(workbenchId, {
          type: "chat.turn-queued",
          data: {
            workbenchId,
            messageId: turn.messageId,
            queueLength: queue.length,
          },
        });
        return;
      }

      // Holds the claim across every batch it dispatches below, rather
      // than releasing and re-claiming between them: releasing early
      // would open a window (each `await` is a yield point) where a
      // fresh, unrelated call could win the claim ahead of a batch that
      // was already queued and waiting — breaking the ordering this
      // queue exists to guarantee. The pending-queue check between
      // batches runs with no `await` in between, so nothing can slip in
      // during it.
      let batch: readonly QueuedTurn[] = [turn];
      try {
        for (;;) {
          await dispatch(batch);
          const next = pendingByWorkbench.get(workbenchId);
          if (next === undefined || next.length === 0) break;
          pendingByWorkbench.delete(workbenchId);
          batch = next;
        }
      } finally {
        await deps.claims.release({ workbenchId });
      }
    },
  };
}
