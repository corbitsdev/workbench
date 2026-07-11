import { getLogger } from "@intx/log";

import type { TaskPushService } from "./push-service";
import type { TaskPushStore } from "./store";

const log = getLogger(["tasks", "reconciler"]);

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_LIMIT = 20;

export type TaskReconcilerPass = {
  scanned: number;
  retried: number;
  synced: number;
};

export interface TaskReconciler {
  reconcileOnce(): Promise<TaskReconcilerPass>;
}

// Bounded retry of refs a push left pending (adapter threw, credential
// missing). The budget is per-ref and in-memory: after `maxAttempts` retries a
// ref stays pending and stops consuming passes — operators see the truth in
// logs, users just keep seeing the send affordance. A restart resets budgets,
// which is fine: retrying a stale pending ref is always safe (both idempotency
// layers hold).
export function createTaskReconciler(deps: {
  store: TaskPushStore;
  pushService: TaskPushService;
  maxAttempts?: number;
  batchLimit?: number;
}): TaskReconciler {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const attemptsByRef = new Map<string, number>();
  let reconciling = false;

  async function reconcileOnce(): Promise<TaskReconcilerPass> {
    if (reconciling) {
      return { scanned: 0, retried: 0, synced: 0 };
    }
    reconciling = true;
    try {
      const pending = await deps.store.listPendingRefs(batchLimit);
      // A ref that already holds an external object was linked by a later push;
      // only never-created refs are retried as creates.
      const retryable = pending.filter((ref) => ref.externalId === null);
      let retried = 0;
      let synced = 0;
      for (const ref of retryable) {
        const attempts = attemptsByRef.get(ref.id) ?? 0;
        if (attempts >= maxAttempts) {
          continue;
        }
        attemptsByRef.set(ref.id, attempts + 1);
        retried += 1;
        const outcome = await deps.pushService.pushTask({
          taskId: ref.taskId,
          adapterId: ref.adapterId,
          operation: "create",
          actorPrincipalId: ref.actorPrincipalId,
        });
        if (outcome.status === "synced") {
          synced += 1;
          attemptsByRef.delete(ref.id);
        } else if (attempts + 1 >= maxAttempts) {
          log.warn("task ref retry budget exhausted; leaving pending", {
            refId: ref.id,
            taskId: ref.taskId,
            adapterId: ref.adapterId,
            attempts: attempts + 1,
          });
        }
      }
      return { scanned: retryable.length, retried, synced };
    } finally {
      reconciling = false;
    }
  }

  return { reconcileOnce };
}
