// Carrying one task's work from the agent that just finished to the
// next agent in line. This is the durable half of a chain: the leg
// rows written at launch are the plan, and this module is the single
// place that turns "leg N finished" into "leg N+1 is running", exactly
// once, with the failure of any leg failing the whole task honestly.
//
// [Intx gap] CL-6052: the platform's own durable delivery path
// (`createWorkflowDispatchService` → `workflow_run_dispatch`) can only
// deliver to an anchor that owns a `sidecar_allocation` row, which is
// minted for exclusive workflow deployments and never for the folded
// runs a task is made of; and the workflow runtime's `action`
// primitive, the other way one run could trigger another, is never
// wired by the production host (`buildRuntimeEnv` in
// `@intx/workflow-host`'s `run-child.ts` leaves `invokeAction`
// undefined, with no binding a host could supply). So the hand-off
// runs in this process instead, inheriting the SAME idempotency
// contract those paths use — a delivery keyed on
// `(parentRunId, messageId)`, a lease that redelivers an unfinished
// attempt, and a claim that can only be won once. What it does not
// inherit is survival across a hub restart mid-hand-off; the sweep in
// `./stuck-legs.ts` is what stops that from being silent. See the
// package README's "Chains" section.
//
// The claim/lease/redelivery logic in `./store.ts` is therefore a
// bounded, deliberately temporary reimplementation of the platform's
// own dispatch pattern, not a second design: CL-6059 and CL-6060 are
// the tracking tickets for closing this gap, and this module and those
// store operations are what gets revisited — and largely retired —
// when they do.
import { getLogger } from "@intx/log";

import type { TaskLegRecord, TaskRecord, TaskStore } from "./store";

const log = getLogger(["tasks", "chain"]);

/** Matches the platform dispatch service's own delivery lease. */
export const LEG_DISPATCH_LEASE_MS = 30_000;

export type LaunchLegPort = (input: {
  readonly tenantId: string;
  readonly principalId: string;
  readonly legId: string;
  readonly definitionId: string;
  readonly prompt: string;
  readonly modelPreference: string | null;
}) => Promise<string>;

export type ChainDeps = {
  readonly store: TaskStore;
  /**
   * Launches one leg and, before returning, durably records its run id
   * on the leg row. Recording must be atomic with the launch itself:
   * a run committed but never recorded would be relaunched by the next
   * claim, running the same work twice.
   */
  readonly launchLeg: LaunchLegPort;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
};

export type ChainAdvance =
  /** The next leg is running; the task is not finished. */
  | {
      readonly kind: "dispatched";
      readonly runId: string;
      readonly legId: string;
    }
  /** No leg follows; the task's terminal state is the settled leg's. */
  | { readonly kind: "chain-complete" }
  /** Another claimant already has the next leg; nothing to do here. */
  | { readonly kind: "already-claimed" }
  /** The hand-off itself failed; the task must fail with this reason. */
  | { readonly kind: "dispatch-failed"; readonly errorMessage: string };

export const HANDOFF_FAILED_MESSAGE =
  "The next agent in this task couldn't be started.";

/**
 * Hands a just-settled leg's work to the leg after it. Returns what
 * the caller must do with the task as a whole — only `chain-complete`
 * and `dispatch-failed` mean the task itself is finished.
 *
 * Every exit is safe to repeat: the claim is winner-takes-all, so a
 * redelivered settlement finds `already-claimed` rather than launching
 * a second agent.
 */
export async function advanceChain(
  deps: ChainDeps,
  input: { readonly task: TaskRecord; readonly settledLeg: TaskLegRecord },
): Promise<ChainAdvance> {
  const now = (deps.now ?? (() => new Date()))();
  const legs = await deps.store.listLegs(input.task.tenantId, input.task.id);
  const next = legs.find(
    (leg) => leg.position === input.settledLeg.position + 1,
  );
  if (next === undefined) return { kind: "chain-complete" };

  const parentRunId = input.settledLeg.runId;
  if (parentRunId === null) {
    return {
      kind: "dispatch-failed",
      errorMessage: HANDOFF_FAILED_MESSAGE,
    };
  }

  const claimed = await deps.store.claimLegDispatch({
    tenantId: input.task.tenantId,
    legId: next.id,
    parentRunId,
    leaseExpiresAt: new Date(
      now.getTime() + (deps.leaseDurationMs ?? LEG_DISPATCH_LEASE_MS),
    ),
    now,
  });
  if (claimed === null) return { kind: "already-claimed" };

  try {
    const runId = await deps.launchLeg({
      tenantId: input.task.tenantId,
      principalId: input.task.principalId,
      legId: claimed.id,
      definitionId: claimed.definitionId,
      prompt: claimed.prompt,
      modelPreference: claimed.modelPreference,
    });
    return { kind: "dispatched", runId, legId: claimed.id };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    log.error`task ${input.task.id}: hand-off to leg ${String(
      claimed.position,
    )} failed: ${reason}`;
    await deps.store.failLegDispatch({
      tenantId: input.task.tenantId,
      legId: claimed.id,
      errorMessage: reason,
      settledAt: now,
    });
    return { kind: "dispatch-failed", errorMessage: HANDOFF_FAILED_MESSAGE };
  }
}
