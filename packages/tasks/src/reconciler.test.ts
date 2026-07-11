import { beforeEach, describe, expect, it } from "bun:test";
import type { Task } from "@workbench/shared";

import type { TaskAdapter } from "./adapter";
import { createTaskPushService } from "./push-service";
import { createTaskReconciler } from "./reconciler";
import { InMemoryTaskPushStore } from "./testing";

function makeTask(id: string): Task {
  return {
    id,
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-owner",
    createdByPrincipalId: "principal-owner",
    title: `Task ${id}`,
    status: "open",
    source: "user",
    links: [],
    externalRefs: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function adapterThatFailsThenSucceeds(failFirst: number): {
  adapter: TaskAdapter;
  attempts: () => number;
} {
  let attempts = 0;
  const adapter: TaskAdapter = {
    id: "fake",
    label: "Fake",
    providerName: "fake-provider",
    operations: ["create"],
    externalRef: { idLabel: "Fake" },
    execute: async () => {
      attempts += 1;
      if (attempts <= failFirst) {
        throw new Error("transient");
      }
      return { externalId: `ext-${attempts}`, deduped: false };
    },
  };
  return { adapter, attempts: () => attempts };
}

describe("createTaskReconciler", () => {
  let store: InMemoryTaskPushStore;
  const credential = { apiKey: "k", baseURL: "https://api" };

  beforeEach(() => {
    store = new InMemoryTaskPushStore();
    store.putTask(makeTask("task-1"));
  });

  it("retries a create that was left pending and marks it synced on recovery", async () => {
    const { adapter, attempts } = adapterThatFailsThenSucceeds(1);
    const pushService = createTaskPushService({
      store,
      resolveCredential: async () => credential,
      adapters: { fake: adapter },
    });

    const first = await pushService.pushTask({
      taskId: "task-1",
      adapterId: "fake",
      operation: "create",
      actorPrincipalId: "principal-owner",
    });
    expect(first).toEqual({ status: "pending" });

    const reconciler = createTaskReconciler({
      store,
      pushService,
      maxAttempts: 3,
    });
    const pass = await reconciler.reconcileOnce();

    expect(pass).toEqual({ scanned: 1, retried: 1, synced: 1 });
    expect(attempts()).toBe(2);
    expect((await store.findRef("task-1", "fake"))?.syncState).toBe("synced");
  });

  it("stops retrying a ref once the attempt budget is exhausted", async () => {
    const { adapter, attempts } = adapterThatFailsThenSucceeds(100);
    const pushService = createTaskPushService({
      store,
      resolveCredential: async () => credential,
      adapters: { fake: adapter },
    });
    await pushService.pushTask({
      taskId: "task-1",
      adapterId: "fake",
      operation: "create",
      actorPrincipalId: "principal-owner",
    });
    const attemptsAfterInitial = attempts();

    const reconciler = createTaskReconciler({
      store,
      pushService,
      maxAttempts: 2,
    });
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    const afterBudget = attempts();
    await reconciler.reconcileOnce();

    expect(attempts()).toBe(afterBudget);
    expect(afterBudget).toBe(attemptsAfterInitial + 2);
    expect((await store.findRef("task-1", "fake"))?.syncState).toBe("pending");
  });

  it("skips refs that already hold an external object", async () => {
    let executeCount = 0;
    const adapter: TaskAdapter = {
      id: "fake",
      label: "Fake",
      providerName: "fake-provider",
      operations: ["create"],
      externalRef: { idLabel: "Fake" },
      execute: async () => {
        executeCount += 1;
        return { externalId: "ext-1", deduped: false };
      },
    };
    const pushService = createTaskPushService({
      store,
      resolveCredential: async () => credential,
      adapters: { fake: adapter },
    });
    await pushService.pushTask({
      taskId: "task-1",
      adapterId: "fake",
      operation: "create",
      actorPrincipalId: "principal-owner",
    });
    expect(executeCount).toBe(1);

    const reconciler = createTaskReconciler({ store, pushService, maxAttempts: 3 });
    const pass = await reconciler.reconcileOnce();

    expect(pass).toEqual({ scanned: 0, retried: 0, synced: 0 });
    expect(executeCount).toBe(1);
  });
});
