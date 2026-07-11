import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";

let reconcileCalls = 0;
const tasksReal = await import("@workbench/tasks");
mock.module("@workbench/tasks", () => ({
  ...tasksReal,
  createTaskPushService: () => ({
    pushTask: async () => ({ status: "pending" }),
  }),
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
mock.module("../lib/task-credential", () => ({
  resolveAdapterCredential: () => async () => null,
}));

const { createTaskReconcilerService } = await import("./task-reconciler");

const db = {} as unknown as HubDb;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createTaskReconcilerService", () => {
  it("does not run any pass while disabled", async () => {
    reconcileCalls = 0;
    const svc = createTaskReconcilerService({
      enabled: false,
      db,
      intervalMs: 5,
    });
    svc.start();
    await delay(30);
    svc.stop();
    expect(reconcileCalls).toBe(0);
  });

  it("drives reconcileOnce on its interval while enabled, and stops cleanly", async () => {
    reconcileCalls = 0;
    const svc = createTaskReconcilerService({
      enabled: true,
      db,
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
