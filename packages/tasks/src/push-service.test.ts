import { beforeEach, describe, expect, it } from "bun:test";
import type { Task } from "@workbench/shared";

import type {
  TaskAdapter,
  TaskAdapterExecutableOperation,
  TaskPushInput,
} from "./adapter";
import { createTaskPushService } from "./push-service";
import { InMemoryTaskPushStore } from "./testing";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-owner",
    createdByPrincipalId: "principal-owner",
    title: "Follow up with Acme",
    status: "open",
    source: "user",
    links: [],
    externalRefs: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

type Call = {
  op: TaskAdapterExecutableOperation;
  input: TaskPushInput;
  config: { apiKey: string; baseURL: string };
};

function makeAdapter(
  execute: TaskAdapter["execute"],
  operations: TaskAdapter["operations"] = ["create", "update", "close", "comment"],
): TaskAdapter {
  return {
    id: "fake",
    label: "Fake",
    providerName: "fake-provider",
    operations,
    externalRef: { idLabel: "Fake object" },
    execute,
  };
}

describe("createTaskPushService.pushTask", () => {
  let store: InMemoryTaskPushStore;
  const credential = { apiKey: "key-1", baseURL: "https://api.example" };

  beforeEach(() => {
    store = new InMemoryTaskPushStore();
    store.putTask(makeTask());
  });

  it("inserts a pending ref then marks it synced on a successful create", async () => {
    const calls: Call[] = [];
    const service = createTaskPushService({
      store,
      resolveCredential: async () => credential,
      adapters: {
        fake: makeAdapter(async (op, input, config) => {
          calls.push({ op, input, config });
          return { externalId: "ext-99", externalUrl: "https://x/99", deduped: false };
        }),
      },
    });

    const outcome = await service.pushTask({
      taskId: "task-1",
      adapterId: "fake",
      operation: "create",
      actorPrincipalId: "principal-owner",
    });

    expect(outcome).toEqual({
      status: "synced",
      externalId: "ext-99",
      externalUrl: "https://x/99",
      deduped: false,
    });
    const ref = await store.findRef("task-1", "fake");
    expect(ref?.syncState).toBe("synced");
    expect(ref?.externalId).toBe("ext-99");
    expect(calls).toHaveLength(1);
  });

  it("passes the wire idempotency key and actor attribution into the adapter", async () => {
    const calls: Call[] = [];
    const service = createTaskPushService({
      store,
      resolveCredential: async () => credential,
      adapters: {
        fake: makeAdapter(async (op, input, config) => {
          calls.push({ op, input, config });
          return { externalId: "ext-1", deduped: false };
        }),
      },
    });

    await service.pushTask({
      taskId: "task-1",
      adapterId: "fake",
      operation: "comment",
      actorPrincipalId: "principal-actor",
    });

    expect(calls[0]?.input.idempotencyKey).toBe("task:task-1:comment");
    expect(calls[0]?.input.actorPrincipalId).toBe("principal-actor");
    expect(calls[0]?.config).toEqual(credential);
    const ref = await store.findRef("task-1", "fake");
    expect(ref?.actorPrincipalId).toBe("principal-actor");
  });

  it("short-circuits a create when the ref is already synced, without calling the adapter", async () => {
    let executeCount = 0;
    const service = createTaskPushService({
      store,
      resolveCredential: async () => credential,
      adapters: {
        fake: makeAdapter(async () => {
          executeCount += 1;
          return { externalId: "ext-1", deduped: false };
        }),
      },
    });

    await service.pushTask({
      taskId: "task-1",
      adapterId: "fake",
      operation: "create",
      actorPrincipalId: "principal-owner",
    });
    const second = await service.pushTask({
      taskId: "task-1",
      adapterId: "fake",
      operation: "create",
      actorPrincipalId: "principal-owner",
    });

    expect(executeCount).toBe(1);
    expect(second).toMatchObject({ status: "synced", deduped: true });
  });

  it("leaves the ref pending and never surfaces an error when the adapter throws", async () => {
    const service = createTaskPushService({
      store,
      resolveCredential: async () => credential,
      adapters: {
        fake: makeAdapter(async () => {
          throw new Error("Attio API error: 500");
        }),
      },
    });

    const outcome = await service.pushTask({
      taskId: "task-1",
      adapterId: "fake",
      operation: "create",
      actorPrincipalId: "principal-owner",
    });

    expect(outcome).toEqual({ status: "pending" });
    const ref = await store.findRef("task-1", "fake");
    expect(ref?.syncState).toBe("pending");
    expect(ref?.externalId).toBeNull();
  });

  it("leaves the ref pending when no credential is configured", async () => {
    let executeCount = 0;
    const service = createTaskPushService({
      store,
      resolveCredential: async () => null,
      adapters: {
        fake: makeAdapter(async () => {
          executeCount += 1;
          return { externalId: "ext-1", deduped: false };
        }),
      },
    });

    const outcome = await service.pushTask({
      taskId: "task-1",
      adapterId: "fake",
      operation: "create",
      actorPrincipalId: "principal-owner",
    });

    expect(outcome).toEqual({ status: "pending" });
    expect(executeCount).toBe(0);
    expect((await store.findRef("task-1", "fake"))?.syncState).toBe("pending");
  });

  it("throws for an unknown adapter", async () => {
    const service = createTaskPushService({
      store,
      resolveCredential: async () => credential,
      adapters: {},
    });
    await expect(
      service.pushTask({
        taskId: "task-1",
        adapterId: "nope",
        operation: "create",
        actorPrincipalId: "principal-owner",
      }),
    ).rejects.toThrow(/unknown task adapter/i);
  });

  it("throws when the adapter does not support the requested operation", async () => {
    const service = createTaskPushService({
      store,
      resolveCredential: async () => credential,
      adapters: {
        fake: makeAdapter(async () => ({ externalId: "ext-1", deduped: false }), [
          "create",
        ]),
      },
    });
    await expect(
      service.pushTask({
        taskId: "task-1",
        adapterId: "fake",
        operation: "close",
        actorPrincipalId: "principal-owner",
      }),
    ).rejects.toThrow(/does not support/i);
  });

  it("throws when the task does not exist", async () => {
    const service = createTaskPushService({
      store,
      resolveCredential: async () => credential,
      adapters: { fake: makeAdapter(async () => ({ externalId: "e", deduped: false })) },
    });
    await expect(
      service.pushTask({
        taskId: "missing",
        adapterId: "fake",
        operation: "create",
        actorPrincipalId: "principal-owner",
      }),
    ).rejects.toThrow(/task not found/i);
  });
});
