import { getLogger } from "@intx/log";
import {
  createTaskPushService,
  createTaskReconciler,
  TASK_ADAPTERS,
} from "@workbench/tasks";
import { resolveAdapterCredential } from "../lib/task-credential";
import { createDrizzleTaskPushStore } from "../lib/task-push-store";
import type { HubDb } from "../db";

const log = getLogger(["services", "task-reconciler"]);

const DEFAULT_INTERVAL_MS = 60_000;

export interface TaskReconcilerService {
  start(): void;
  stop(): void;
}

// Periodically retries task_external_ref rows a push left `pending`. The
// underlying `createTaskReconciler` owns the per-ref retry budget and its own
// reentrancy guard; this wrapper only drives it on an interval and is gated by
// the TASKS_RECONCILER_ENABLED kill switch (default OFF).
export function createTaskReconcilerService(deps: {
  enabled: boolean;
  db: HubDb;
  intervalMs?: number;
}): TaskReconcilerService {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const store = createDrizzleTaskPushStore(deps.db);
  const pushService = createTaskPushService({
    store,
    adapters: TASK_ADAPTERS,
    resolveCredential: resolveAdapterCredential(deps.db),
  });
  const reconciler = createTaskReconciler({ store, pushService });
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    start() {
      if (!deps.enabled) {
        log.info("task-reconciler: disabled");
        return;
      }
      if (timer) return;
      timer = setInterval(() => {
        void reconciler
          .reconcileOnce()
          .then((pass) => {
            if (pass.retried > 0 || pass.synced > 0) {
              log.info("task-reconciler: pass", pass);
            }
          })
          .catch((err) =>
            log.error("task-reconciler: pass failed", {
              error: err instanceof Error ? err : new Error(String(err)),
            }),
          );
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
