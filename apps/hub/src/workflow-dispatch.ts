// Composition for the platform's durable workflow dispatch service.
// Nothing here decides anything about the product — it wires
// `@intx/hub-sessions`' own `createWorkflowDispatchService` to this
// app's database, sidecar router and event stream, and starts the two
// loops the service needs to make progress:
//
//   - the sidecar-ready requeue: when an exclusive worker acknowledges
//     its deploy, every payload the previous generation never settled
//     becomes deliverable again;
//   - the reconcile tick: a retry that was scheduled for later has no
//     other way to be noticed, since `enqueue` only wakes the drain for
//     work arriving now.
//
// Settlement itself is not wired here. The Git run log is the
// settlement authority and `createHubSessionLookups` already projects
// it onto `workflow_run_dispatch` on every accepted workflow-run pack;
// a second settlement path in this app would be a competing authority,
// which is exactly what the claim-check design forbids.
import { eq } from "drizzle-orm";
import {
  createSidecarAllocationStore,
  createWorkflowRunDispatchStore,
  type DB,
} from "@intx/db";
import { workflowRun } from "@intx/db/schema";
import {
  createWorkflowDispatchService,
  type SidecarAllocationRouter,
  type SidecarEventEmitter,
  type WorkflowDispatchService,
} from "@intx/hub-sessions";
import { getLogger } from "@intx/log";

const log = getLogger(["hub", "workflow-dispatch"]);

/** Long enough that the tick is not a busy loop, short enough that a
 * backed-off retry is picked up promptly once its delay passes. */
export const DISPATCH_RECONCILE_INTERVAL_MS = 5_000;

export type WorkflowDispatchWiringDeps = {
  readonly db: DB["db"];
  readonly router: SidecarAllocationRouter;
  readonly events: SidecarEventEmitter;
  readonly reconcileIntervalMs?: number;
};

export type WorkflowDispatchWiring = {
  readonly service: WorkflowDispatchService;
  stop(): void;
};

export function startWorkflowDispatch(
  deps: WorkflowDispatchWiringDeps,
): WorkflowDispatchWiring {
  const service = createWorkflowDispatchService({
    dispatchStore: createWorkflowRunDispatchStore(deps.db),
    allocationStore: createSidecarAllocationStore(deps.db),
    router: deps.router,
    resolveAnchorAddress: async (anchorRunId) => {
      const [row] = await deps.db
        .select({ address: workflowRun.address })
        .from(workflowRun)
        .where(eq(workflowRun.id, anchorRunId))
        .limit(1);
      return row?.address ?? null;
    },
  });

  const unsubscribeDeployAck = deps.events.on("agent.deploy.ack", (payload) => {
    const allocated = payload.allocated;
    if (allocated === undefined) return;
    void service
      .requeueForReadyAllocation(allocated.anchorRunId)
      .catch((cause: unknown) => {
        log.error`requeue for ready allocation ${allocated.allocationId} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
      });
  });

  const unsubscribeInboundAck = deps.events.on(
    "mail.inbound.acknowledged",
    (payload) => {
      const allocated = payload.allocated;
      if (allocated === undefined) return;
      void service
        .acknowledge({
          allocationId: allocated.allocationId,
          anchorRunId: allocated.anchorRunId,
          generation: allocated.generation,
          messageId: payload.messageId,
        })
        .catch((cause: unknown) => {
          log.error`acknowledging dispatch ${payload.messageId} failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        });
    },
  );

  const reconcile = setInterval(() => {
    service.wake();
  }, deps.reconcileIntervalMs ?? DISPATCH_RECONCILE_INTERVAL_MS);
  reconcile.unref?.();

  return {
    service,
    stop() {
      clearInterval(reconcile);
      unsubscribeDeployAck();
      unsubscribeInboundAck();
    },
  };
}
