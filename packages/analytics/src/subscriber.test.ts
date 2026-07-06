import { describe, expect, mock, test } from "bun:test";
import type { InferenceEvent } from "@intx/types/runtime";

import { createAnalyticsSubscriber } from "./subscriber";

const supervisorInstance = {
  id: "ins_ses_test",
  agentId: "ins_ses_test",
  tenantId: "tnt_test",
  principalId: "prn_test",
  sessionId: "ses_supervisor",
  address: "ins_ses_test@deploy.example.com",
  endedAt: null,
};

const baseInstance = {
  id: "ins_test",
  agentId: "agt_test",
  tenantId: "tnt_test",
  principalId: "prn_test",
  sessionId: "ses_test",
  address: "agent@example.test",
  endedAt: null,
};

type Instance = typeof supervisorInstance;

function makeDb({
  instance = supervisorInstance as Instance | null,
  onInsert,
  insertReturns = [{ id: "ane_new" }] as { id: string }[],
}: {
  instance?: Instance | null;
  onInsert?: (values: unknown) => void;
  insertReturns?: { id: string }[];
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

const inferenceDone: InferenceEvent = {
  type: "inference.done",
  seq: 10,
  data: {
    turn: { role: "assistant", content: [], model: "m", timestamp: 0 },
    usage: { input: 100, output: 40, cacheRead: 1, cacheWrite: 2, thinking: 3 },
    source: { sourceId: "s", provider: "openai-compatible", model: "m" },
  },
};

const inferenceUsage: InferenceEvent = {
  type: "inference.usage",
  seq: 11,
  data: {
    usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { sourceId: "s", provider: "openai-compatible", model: "m" },
  },
};

const turnCompleted: InferenceEvent = {
  type: "message.run.ended",
  seq: 12,
  data: { messageRunId: "mrn_1", messageId: "msg_1", status: "completed" },
};

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

describe("analytics subscriber (mocked db)", () => {
  test("supervisor inference.done persists fact and token rollup", async () => {
    const inserts: unknown[] = [];
    const { db } = makeDb({ onInsert: (v) => inserts.push(v) });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: supervisorInstance.address,
      event: inferenceDone,
    });

    expect(db.insert).toHaveBeenCalledTimes(2);
    const rollup = inserts[1] as Record<string, unknown>;
    expect(rollup["inputTokens"]).toBe(100);
    expect(rollup["outputTokens"]).toBe(40);
    const fact = inserts[0] as Record<string, unknown>;
    expect(String(fact["eventKey"])).toBe(
      "ses_supervisor:ins_ses_test@deploy.example.com:10:inference.done",
    );
  });

  test("persists the exact token breakdown from a known usage payload", async () => {
    const inserts: unknown[] = [];
    const { db } = makeDb({ onInsert: (v) => inserts.push(v) });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: supervisorInstance.address,
      event: inferenceDone,
    });

    const fact = inserts[0] as Record<string, unknown>;
    expect(fact["inputTokens"]).toBe(100);
    expect(fact["outputTokens"]).toBe(40);
    expect(fact["cacheReadTokens"]).toBe(1);
    expect(fact["cacheWriteTokens"]).toBe(2);
    expect(fact["thinkingTokens"]).toBe(3);
    expect(fact["eventType"]).toBe("inference_done");
    expect(fact["sessionId"]).toBe("ses_supervisor");
  });

  test("supervisor message.run.ended increments turn rollup", async () => {
    const { db } = makeDb();
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: supervisorInstance.address,
      event: turnCompleted,
    });

    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  test("supervisor inference.error persists fact only (no rollup)", async () => {
    const { db } = makeDb();
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    const event: InferenceEvent = {
      type: "inference.error",
      seq: 13,
      data: {
        error: { category: "fatal", message: "boom" },
        partial: { text: "" },
      },
    };

    await subscriber.onAgentEvent({
      agentAddress: supervisorInstance.address,
      event,
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  test("supervisor inference.usage persists fact only", async () => {
    const { db } = makeDb();
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: supervisorInstance.address,
      event: inferenceUsage,
    });

    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

describe("createAnalyticsSubscriber (unit)", () => {
  test("skips persistence when no facts map from the event", async () => {
    const { db } = makeDb({ instance: baseInstance });
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

  test("skips persistence when instance.sessionId is null", async () => {
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
    const { db } = makeDb({ instance: baseInstance });
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
    const { db } = makeDb({
      instance: baseInstance,
      onInsert: (v) => capturedInserts.push(v),
    });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: usageEvent,
    });

    const factInsert = capturedInserts[0] as Record<string, unknown>;
    expect(String(factInsert["eventKey"])).toBe(
      "ses_test:agent@example.test:1:inference.usage",
    );
  });

  test("onLocalInferenceEvent attributes to the caller instance and namespaces the key by eventAddress", async () => {
    const inserts: unknown[] = [];
    const { db } = makeDb({
      instance: baseInstance,
      onInsert: (v) => inserts.push(v),
    });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onLocalInferenceEvent({
      tenantId: "tnt_test",
      attributionPrincipalId: "prn_test",
      eventAddress: "file-parser-abc",
      event: inferenceDone,
    });

    // Resolves the caller instance by principal, not by address.
    expect(db.query.agentInstance.findFirst).toHaveBeenCalledTimes(1);
    const fact = inserts[0] as Record<string, unknown>;
    expect(fact["instanceId"]).toBe("ins_test");
    expect(fact["principalId"]).toBe("prn_test");
    expect(fact["inputTokens"]).toBe(100);
    expect(fact["outputTokens"]).toBe(40);
    // Key is namespaced by the one-shot's OWN address (not the caller's), so its
    // seq space cannot collide with the caller's sidecar events under the shared
    // session prefix — no double-counting.
    expect(String(fact["eventKey"])).toBe(
      "ses_test:file-parser-abc:10:inference.done",
    );
  });

  test("onLocalInferenceEvent writes NO row when the caller has no active instance", async () => {
    const { db } = makeDb({ instance: null });
    const subscriber = createAnalyticsSubscriber({ db: db as never });

    await subscriber.onLocalInferenceEvent({
      tenantId: "tnt_test",
      attributionPrincipalId: "prn_missing",
      eventAddress: "file-parser-xyz",
      event: inferenceDone,
    });

    // Honest attribution: no instance → no orphaned row.
    expect(db.insert).not.toHaveBeenCalled();
  });

  test("skips rollup upsert when event key already exists (onConflictDoNothing)", async () => {
    // Case A: the event insert returns nothing (conflict). The
    // `inserted.length === 0` guard must short-circuit BEFORE upsertDailyRollup,
    // so only the event insert runs. inference.done is used (not inference.usage)
    // because inference.usage returns early on its own and would never reach —
    // let alone exercise — the conflict guard.
    const conflict = makeDb({ instance: baseInstance, insertReturns: [] });
    const conflictSubscriber = createAnalyticsSubscriber({
      db: conflict.db as never,
    });

    await conflictSubscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: inferenceDone,
    });

    expect(conflict.db.insert).toHaveBeenCalledTimes(1);
    expect(conflict.insertChain.onConflictDoUpdate).not.toHaveBeenCalled();

    // Case B: the event insert returns a row (no conflict). The guard passes and
    // the rollup upsert runs, so insert is called twice and the rollup chain's
    // onConflictDoUpdate fires.
    const fresh = makeDb({
      instance: baseInstance,
      insertReturns: [{ id: "ane_new" }],
    });
    const freshSubscriber = createAnalyticsSubscriber({
      db: fresh.db as never,
    });

    await freshSubscriber.onAgentEvent({
      agentAddress: "agent@example.test",
      event: inferenceDone,
    });

    expect(fresh.db.insert).toHaveBeenCalledTimes(2);
    expect(fresh.insertChain.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });
});
