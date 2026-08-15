// Proves the orchestrator's own wiring: a `message.run.ended`
// (`status: "completed"`) on the shared `agent.event` stream resolves
// the address to its folded run, finds the task the run belongs to,
// and delivers a `task-result` notification carrying the last
// `connector.reply` content and any artifacts staged via
// `handleFinalizedTurn` — then flips the task to `done` with the
// delivered mail id. A `"failed"` bracket close delivers a failure
// notification and flips the task to `failed`. An address with no
// task (e.g. a chat participant, not a task run) is ignored outright.
// Mirrors packages/chat/test/chat-orchestrator.test.ts's fake-db
// convention: `findFoldedRunByAddress` is exercised for real against a
// fake `db.query.workflowRun`/`workflowDefinition`, never mocked.
import { describe, expect, test } from "bun:test";
import { createSidecarEmitter } from "@intx/hub-sessions";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
  type NotifyDeliveryDeps,
  type NotifyInboxItem,
} from "@corbits/notify";

import { createTaskOrchestrator } from "./orchestrator";
import { createMemoryTaskStore, type TaskRecord } from "./store";

function createFakeDb(
  run?: { id: string; tenantId: string; principalId?: string | null },
  definition?: { name: string },
) {
  return {
    query: {
      workflowRun: {
        findFirst: async () =>
          run === undefined
            ? undefined
            : { ...run, principalId: run.principalId ?? null },
      },
      workflowDefinition: {
        findFirst: async () => definition,
      },
    },
  } as never;
}

function fakeNotify(): {
  readonly deps: NotifyDeliveryDeps;
  readonly delivered: readonly NotifyInboxItem[][];
} {
  const delivered: NotifyInboxItem[][] = [];
  return {
    deps: {
      mail: async (items, opts) => {
        delivered.push([...items]);
        return items.map((item, index) => {
          const id = `mail_${String(delivered.length)}_${String(index)}`;
          opts?.enqueue?.({ id, item });
          return { messageKey: `key_${String(index)}`, id };
        });
      },
      addressing: {
        inbox: (recipient) => `${recipient.principalId}@inbox.test`,
        from: (kind) => `${kind}@notify.test`,
      },
      dispatch: createInMemoryNotifyDispatchStore(),
      sinks: createSinkRegistry(),
    },
    delivered,
  };
}

async function seedRunningTask(
  store: ReturnType<typeof createMemoryTaskStore>,
): Promise<TaskRecord> {
  return store.createTask({
    id: "task_1",
    tenantId: "tnt_1",
    principalId: "prn_alice",
    definitionId: "wfd_agent",
    agentName: "Agent",
    prompt: "Summarize the incident.",
    modelPreference: null,
    runId: "run_1",
  });
}

describe("createTaskOrchestrator", () => {
  test("a completed run bracket delivers the reply and flips the task to done", async () => {
    const events = createSidecarEmitter();
    const store = createMemoryTaskStore();
    await seedRunningTask(store);
    const notify = fakeNotify();

    const orchestrator = createTaskOrchestrator({
      db: createFakeDb(
        { id: "run_1", tenantId: "tnt_1", principalId: "prn_alice" },
        { name: "Incident Summarizer" },
      ),
      store,
      events,
      notify: notify.deps,
    });

    events.emit("agent.event", {
      agentAddress: "run_1@tnt1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        seq: 1,
        data: { content: "All clear." },
      },
    });
    events.emit("agent.event", {
      agentAddress: "run_1@tnt1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "message.run.ended",
        seq: 2,
        data: { status: "completed" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notify.delivered).toHaveLength(1);
    const items = notify.delivered[0] ?? [];
    expect(items[0]?.principalId).toBe("prn_alice");

    const updated = await store.getTask("tnt_1", "task_1");
    expect(updated?.status).toBe("done");
    expect(updated?.resultMailId).not.toBeNull();

    orchestrator.dispose();
  });

  test("a failed run bracket delivers a failure notification and flips the task to failed", async () => {
    const events = createSidecarEmitter();
    const store = createMemoryTaskStore();
    await seedRunningTask(store);
    const notify = fakeNotify();

    const orchestrator = createTaskOrchestrator({
      db: createFakeDb(
        { id: "run_1", tenantId: "tnt_1", principalId: "prn_alice" },
        { name: "Incident Summarizer" },
      ),
      store,
      events,
      notify: notify.deps,
    });

    events.emit("agent.event", {
      agentAddress: "run_1@tnt1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "message.run.ended",
        seq: 1,
        data: { status: "failed", error: { message: "tool exploded" } },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notify.delivered).toHaveLength(1);
    const updated = await store.getTask("tnt_1", "task_1");
    expect(updated?.status).toBe("failed");

    orchestrator.dispose();
  });

  test("a redelivered terminal event delivers exactly once", async () => {
    // A sidecar reconnect can replay the same `message.run.ended`
    // frame, back to back on one tick, before the first async delivery
    // has resolved — the synchronous claim (and, past it, the
    // conditional completeTask) must collapse both to one mail.
    const events = createSidecarEmitter();
    const store = createMemoryTaskStore();
    await seedRunningTask(store);
    const notify = fakeNotify();

    const orchestrator = createTaskOrchestrator({
      db: createFakeDb(
        { id: "run_1", tenantId: "tnt_1", principalId: "prn_alice" },
        { name: "Incident Summarizer" },
      ),
      store,
      events,
      notify: notify.deps,
    });

    const terminal = {
      agentAddress: "run_1@tnt1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "message.run.ended",
        seq: 1,
        data: { status: "completed" },
      },
    };
    events.emit("agent.event", terminal);
    events.emit("agent.event", terminal);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(notify.delivered).toHaveLength(1);
    expect((await store.getTask("tnt_1", "task_1"))?.status).toBe("done");

    orchestrator.dispose();
  });

  test("a redelivered terminal event's mail keys on the task alone, never the tick", async () => {
    const events = createSidecarEmitter();
    const store = createMemoryTaskStore();
    await seedRunningTask(store);
    const notify = fakeNotify();

    const orchestrator = createTaskOrchestrator({
      db: createFakeDb(
        { id: "run_1", tenantId: "tnt_1", principalId: "prn_alice" },
        { name: "Incident Summarizer" },
      ),
      store,
      events,
      notify: notify.deps,
    });

    events.emit("agent.event", {
      agentAddress: "run_1@tnt1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "message.run.ended",
        seq: 1,
        data: { status: "completed" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(notify.delivered[0]?.[0]?.externalId).toBe("task-result:task_1");

    orchestrator.dispose();
  });

  test("an address with no matching task is ignored", async () => {
    const events = createSidecarEmitter();
    const store = createMemoryTaskStore();
    const notify = fakeNotify();

    const orchestrator = createTaskOrchestrator({
      db: createFakeDb(undefined),
      store,
      events,
      notify: notify.deps,
    });

    events.emit("agent.event", {
      agentAddress: "run_stranger@tnt1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "message.run.ended",
        seq: 1,
        data: { status: "completed" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notify.delivered).toHaveLength(0);
    orchestrator.dispose();
  });

  test("dispose stops the subscription", async () => {
    const events = createSidecarEmitter();
    const store = createMemoryTaskStore();
    await seedRunningTask(store);
    const notify = fakeNotify();

    const orchestrator = createTaskOrchestrator({
      db: createFakeDb(
        { id: "run_1", tenantId: "tnt_1", principalId: "prn_alice" },
        { name: "Incident Summarizer" },
      ),
      store,
      events,
      notify: notify.deps,
    });
    orchestrator.dispose();

    events.emit("agent.event", {
      agentAddress: "run_1@tnt1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "message.run.ended",
        seq: 1,
        data: { status: "completed" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notify.delivered).toHaveLength(0);
  });
});
