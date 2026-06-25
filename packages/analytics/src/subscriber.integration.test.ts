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

function makeDb({
  onInsert,
  insertReturns = [{ id: "ane_new" }] as { id: string }[],
}: {
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
        findFirst: mock(() => Promise.resolve(supervisorInstance)),
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

describe("analytics subscriber integration (hub seam)", () => {
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
    expect(String(fact["eventKey"])).toStartWith("ses_supervisor:");
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
