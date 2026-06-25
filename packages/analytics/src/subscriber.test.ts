import { describe, expect, mock, test } from "bun:test";

import type { InferenceEvent } from "@intx/types/runtime";

import { createAnalyticsSubscriber } from "./subscriber";

const baseInstance = {
  id: "ins_test",
  agentId: "agt_test",
  tenantId: "tnt_test",
  principalId: "prn_test",
  sessionId: "ses_test",
  address: "agent@example.test",
  endedAt: null,
};

function makeDb({
  instance = baseInstance as typeof baseInstance | null,
  insertReturns = [{ id: "ane_new" }] as { id: string }[],
  onInsert,
}: {
  instance?: typeof baseInstance | null;
  insertReturns?: { id: string }[];
  onInsert?: (values: unknown) => void;
} = {}) {
  const insertChain = {
    values: mock((values: unknown) => {
      onInsert?.(values);
      return insertChain;
    }),
    onConflictDoNothing: mock(() => insertChain),
    onConflictDoUpdate: mock(() => Promise.resolve()),
    returning: mock(() => Promise.resolve(insertReturns)),
  };

  const db = {
    query: {
      agentInstance: {
        findFirst: mock(() => Promise.resolve(instance ?? undefined)),
      },
    },
    insert: mock(() => insertChain),
    transaction: mock(async (fn: (tx: typeof db) => Promise<void>) => fn(db)),
  };

  return { db, insertChain };
}

const usageEvent: InferenceEvent = {
  type: "inference.usage",
  seq: 1,
  data: {
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: {
      sourceId: "src_1",
      provider: "openai-compatible",
      model: "claude-sonnet",
    },
  },
};

const turnCompletedEvent: InferenceEvent = {
  type: "message.run.ended",
  seq: 2,
  data: { messageRunId: "mrn_1", messageId: "msg_1", status: "completed" },
};

const inferenceDoneEvent: InferenceEvent = {
  type: "inference.done",
  seq: 3,
  data: {
    turn: {
      role: "assistant",
      content: [],
      model: "claude-sonnet",
      timestamp: 0,
    },
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: {
      sourceId: "src_1",
      provider: "openai-compatible",
      model: "claude-sonnet",
    },
  },
};

describe("createAnalyticsSubscriber", () => {
  test("skips persistence when no facts map from the event", async () => {
    const { db } = makeDb();
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: {
        type: "inference.text.delta",
        seq: 1,
        data: { token: "x", partial: { text: "x" } },
      },
    });

    expect(db.query.agentInstance.findFirst).not.toHaveBeenCalled();
  });

  test("warns and skips when no active instance is found for the address", async () => {
    const { db } = makeDb({ instance: null });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: usageEvent,
    });

    expect(db.insert).not.toHaveBeenCalled();
  });

  test("throws and surfaces the error when instance.sessionId is null", async () => {
    const nullSession = { ...baseInstance, sessionId: null };
    const { db } = makeDb({ instance: nullSession as never });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: usageEvent,
    });

    expect(db.insert).not.toHaveBeenCalled();
  });

  test("caches instance lookup — findFirst called once across multiple events", async () => {
    const { db } = makeDb();
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: usageEvent,
    });
    await subscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: usageEvent,
    });

    expect(db.query.agentInstance.findFirst).toHaveBeenCalledTimes(1);
  });

  test("qualifies the event key with sessionId to prevent cross-session collisions", async () => {
    const capturedInserts: unknown[] = [];
    const { db } = makeDb({ onInsert: (v) => capturedInserts.push(v) });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: usageEvent,
    });

    const factInsert = capturedInserts[0] as Record<string, unknown>;
    expect(String(factInsert["eventKey"])).toStartWith(
      "ses_test:agent@example.test:1:inference.usage",
    );
  });

  test("skips rollup upsert when event key already exists (onConflictDoNothing)", async () => {
    const { db } = makeDb({ insertReturns: [] });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: usageEvent,
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  test("rolls up token totals from inference_done (not inference.usage)", async () => {
    const { db } = makeDb();
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: inferenceDoneEvent,
    });

    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  test("performs both fact insert and rollup upsert for message.run.ended (turn_completed)", async () => {
    const { db } = makeDb();
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: turnCompletedEvent,
    });

    expect(db.insert).toHaveBeenCalledTimes(2);
  });
});
