import { getLogger } from "@intx/log";
import { createTaskReconciler } from "@workbench/tasks";
import type { TaskPushService } from "@workbench/tasks";
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
// the `tasks-reconciler` feature grant (env override OR owner grant on the
// root tenant, checked fresh every tick so a live toggle takes effect without
// a restart; default OFF).
export function createTaskReconcilerService(deps: {
  isEnabled: () => Promise<boolean>;
  db: HubDb;
  pushService: TaskPushService;
  intervalMs?: number;
}): TaskReconcilerService {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const store = createDrizzleTaskPushStore(deps.db);
  const reconciler = createTaskReconciler({
    store,
    pushService: deps.pushService,
  });
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void deps
          .isEnabled()
          .then((enabled) => {
            if (!enabled) return undefined;
            return reconciler.reconcileOnce().then((pass) => {
              if (pass.retried > 0 || pass.synced > 0) {
                log.info("task-reconciler: pass", pass);
              }
            });
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
