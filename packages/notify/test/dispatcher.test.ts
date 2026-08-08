import { describe, expect, test } from "bun:test";

import {
  createInMemoryNotifyDispatchStore,
  createNotifyDispatcher,
  createSinkRegistry,
  DuplicateSinkNameError,
  type NotificationEvent,
  type NotificationSinkPlugin,
  type NotifyDispatchLogger,
  type SinkDeliveryResult,
} from "../src/index";

const event: NotificationEvent = {
  kind: "approval",
  approvalId: "apr_1",
  tenantId: "tnt_1",
  runId: "run_1",
  deploymentId: "dep_1",
  toolName: "send_invoice",
  toolArguments: {},
  recipients: [{ tenantId: "tnt_1", principalId: "prn_1" }],
  createdAt: "2026-08-08T10:00:00.000Z",
};

const silent: NotifyDispatchLogger = {
  warn: () => undefined,
  error: () => undefined,
};

function fakeSink(
  name: string,
  results: SinkDeliveryResult[],
): { plugin: NotificationSinkPlugin; calls: number[] } {
  const calls: number[] = [];
  let index = 0;
  const plugin: NotificationSinkPlugin = {
    name,
    isEnabledFor: async () => true,
    deliver: async () => {
      calls.push(index);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return result ?? { status: "delivered" };
    },
  };
  return { plugin, calls };
}

function dispatcherOver(
  sinks: ReturnType<typeof createSinkRegistry>,
  store: ReturnType<typeof createInMemoryNotifyDispatchStore>,
) {
  return createNotifyDispatcher({
    store,
    sinks,
    log: silent,
    loadEvent: async () => event,
    tickIntervalMs: 60_000,
    batchSize: 25,
    maxAttempts: 3,
    retryBackoffMs: 1_000,
  });
}

describe("createNotifyDispatcher", () => {
  test("does nothing, and does not throw, with no sink registered", async () => {
    const store = createInMemoryNotifyDispatchStore();
    const dispatcher = dispatcherOver(createSinkRegistry(), store);
    expect(await dispatcher.runOnce(new Date())).toBe(0);
  });

  test("marks a delivered row delivered and stops retrying it", async () => {
    const store = createInMemoryNotifyDispatchStore();
    const sinks = createSinkRegistry();
    const { plugin, calls } = fakeSink("test", [{ status: "delivered" }]);
    sinks.register(plugin);
    await store.enqueue([
      {
        mailboxRowId: "mail-1",
        tenantId: "tnt_1",
        principalId: "prn_1",
        sinkName: "test",
      },
    ]);
    const dispatcher = dispatcherOver(sinks, store);

    expect(await dispatcher.runOnce(new Date())).toBe(1);
    const [row] = await store.listFor("mail-1");
    expect(row?.status).toBe("delivered");
    expect(row?.attempts).toBe(1);
    expect(await dispatcher.runOnce(new Date())).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("backs a retryable failure off, then gives up at the attempt ceiling", async () => {
    const store = createInMemoryNotifyDispatchStore();
    const sinks = createSinkRegistry();
    const { plugin } = fakeSink("test", [
      { status: "failed", error: "rate limited", retryable: true },
    ]);
    sinks.register(plugin);
    await store.enqueue([
      {
        mailboxRowId: "mail-1",
        tenantId: "tnt_1",
        principalId: "prn_1",
        sinkName: "test",
      },
    ]);
    const dispatcher = dispatcherOver(sinks, store);

    const first = new Date("2026-08-08T10:00:00.000Z");
    await dispatcher.runOnce(first);
    let [row] = await store.listFor("mail-1");
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("rate limited");
    expect(row?.nextAttemptAt.getTime()).toBe(first.getTime() + 1_000);

    // Nothing is due until the backoff elapses.
    expect(await dispatcher.runOnce(first)).toBe(0);

    await dispatcher.runOnce(new Date(first.getTime() + 10_000));
    await dispatcher.runOnce(new Date(first.getTime() + 100_000));
    [row] = await store.listFor("mail-1");
    expect(row?.attempts).toBe(3);
    expect(row?.status).toBe("dead");
  });

  test("a non-retryable failure dies on its first attempt", async () => {
    const store = createInMemoryNotifyDispatchStore();
    const sinks = createSinkRegistry();
    const { plugin } = fakeSink("test", [
      { status: "failed", error: "no such channel", retryable: false },
    ]);
    sinks.register(plugin);
    await store.enqueue([
      {
        mailboxRowId: "mail-1",
        tenantId: "tnt_1",
        principalId: "prn_1",
        sinkName: "test",
      },
    ]);
    await dispatcherOver(sinks, store).runOnce(new Date());
    const [row] = await store.listFor("mail-1");
    expect(row?.status).toBe("dead");
    expect(row?.attempts).toBe(1);
  });

  test("a throwing sink is treated as a retryable failure, never a crash", async () => {
    const store = createInMemoryNotifyDispatchStore();
    const sinks = createSinkRegistry();
    sinks.register({
      name: "test",
      isEnabledFor: async () => true,
      deliver: async () => {
        throw new Error("socket hang up");
      },
    });
    await store.enqueue([
      {
        mailboxRowId: "mail-1",
        tenantId: "tnt_1",
        principalId: "prn_1",
        sinkName: "test",
      },
    ]);
    await dispatcherOver(sinks, store).runOnce(new Date());
    const [row] = await store.listFor("mail-1");
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("socket hang up");
  });

  test("rows left behind by an unregistered sink are closed out", async () => {
    const store = createInMemoryNotifyDispatchStore();
    await store.enqueue([
      {
        mailboxRowId: "mail-1",
        tenantId: "tnt_1",
        principalId: "prn_1",
        sinkName: "removed",
      },
    ]);
    await dispatcherOver(createSinkRegistry(), store).runOnce(new Date());
    const [row] = await store.listFor("mail-1");
    expect(row?.status).toBe("dead");
  });
});

describe("createSinkRegistry", () => {
  test("refuses two sinks with the same name", () => {
    const sinks = createSinkRegistry();
    const { plugin } = fakeSink("test", [{ status: "delivered" }]);
    sinks.register(plugin);
    expect(() => sinks.register(plugin)).toThrow(DuplicateSinkNameError);
  });

  test("lists only the sinks enabled for a principal", async () => {
    const sinks = createSinkRegistry();
    sinks.register({
      name: "on",
      isEnabledFor: async (scope) => scope.principalId === "prn_1",
      deliver: async () => ({ status: "delivered" }),
    });
    sinks.register({
      name: "off",
      isEnabledFor: async () => false,
      deliver: async () => ({ status: "delivered" }),
    });
    const enabled = await sinks.listEnabledFor({
      tenantId: "tnt_1",
      principalId: "prn_1",
    });
    expect(enabled.map((sink) => sink.name)).toEqual(["on"]);
    expect(sinks.list()).toHaveLength(2);
  });
});
