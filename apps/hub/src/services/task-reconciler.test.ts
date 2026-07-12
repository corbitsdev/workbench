import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";

let reconcileCalls = 0;
const tasksReal = await import("@workbench/tasks");
mock.module("@workbench/tasks", () => ({
  ...tasksReal,
  createTaskReconciler: () => ({
    reconcileOnce: async () => {
      reconcileCalls += 1;
      return { scanned: 0, retried: 0, synced: 0 };
    },
  }),
  TASK_ADAPTERS: {},
}));
mock.module("../lib/task-push-store", () => ({
  createDrizzleTaskPushStore: () => ({}),
}));

const { createTaskReconcilerService } = await import("./task-reconciler");

const db = {} as unknown as HubDb;
const stubPushService = {
  pushTask: async () => ({ status: "pending" as const }),
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createTaskReconcilerService", () => {
  it("does not run any pass while isEnabled resolves false", async () => {
    reconcileCalls = 0;
    const svc = createTaskReconcilerService({
      isEnabled: async () => false,
      db,
      pushService: stubPushService,
      intervalMs: 5,
    });
    svc.start();
    await delay(30);
    svc.stop();
    expect(reconcileCalls).toBe(0);
  });

  it("drives reconcileOnce on its interval while isEnabled resolves true, and stops cleanly", async () => {
    reconcileCalls = 0;
    const svc = createTaskReconcilerService({
      isEnabled: async () => true,
      db,
      pushService: stubPushService,
      intervalMs: 5,
    });
    svc.start();
    await delay(30);
    svc.stop();
    const afterStop = reconcileCalls;
    expect(afterStop).toBeGreaterThan(0);
    await delay(20);
    expect(reconcileCalls).toBe(afterStop);
  });
});
