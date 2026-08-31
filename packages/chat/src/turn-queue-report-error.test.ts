// The turn queue's three catch paths (rejecting dispatch, claim-store
// throw mid-drain, reclaim throw on enqueue) must call reportError in
// the catch itself so a failure always has a refId — helpers that wrap
// reportError are invisible to check:report-error.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createInMemoryTurnClaimStore } from "./turn-claims";
import type { TurnClaimStore } from "./turn-claims";
import type { QueuedTurn } from "./turn-queue";

const reportErrorCalls: {
  error: unknown;
  context: Record<string, unknown>;
}[] = [];

mock.module("@corbits/error-sink", () => ({
  reportError: (error: unknown, context: Record<string, unknown>) => {
    reportErrorCalls.push({ error, context });
    return "ref_test";
  },
  generateRefId: () => "ref_test",
}));

const { createWorkbenchTurnQueue } = await import("./turn-queue");

function turn(messageId: string, text: string): QueuedTurn {
  return {
    messageId,
    principalId: "prn_1",
    recipients: ["ins_echo1@acme.example"],
    parts: [{ kind: "text", text }],
  };
}

beforeEach(() => {
  reportErrorCalls.length = 0;
});
afterAll(() => {
  mock.restore();
});

describe("createWorkbenchTurnQueue reportError", () => {
  test("a rejecting dispatch reports through reportError and does not reject run()", async () => {
    const queue = createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
      publish: () => undefined,
    });
    const boom = new Error("dispatch blew up");

    await queue.run("wb_1", turn("msg_1", "one"), async () => {
      throw boom;
    });

    expect(reportErrorCalls).toHaveLength(1);
    expect(reportErrorCalls[0]?.error).toBe(boom);
    expect(reportErrorCalls[0]?.context).toEqual({
      operation: "chat.turnQueue.dispatch",
      roomId: "wb_1",
      extra: { messageIds: ["msg_1"] },
    });
  });

  test("a claim-store throw mid-drain reports through reportError", async () => {
    const holders = new Map<string, string>();
    let n = 0;
    const boom = new Error("claim store connection reset");
    const claims: TurnClaimStore = {
      async tryClaim(c) {
        if (holders.has(c.workbenchId)) return false;
        const t = String(++n);
        holders.set(c.workbenchId, t);
        return t;
      },
      async release(c, t) {
        if (holders.get(c.workbenchId) !== t) return false;
        holders.delete(c.workbenchId);
        return true;
      },
      async holds() {
        throw boom;
      },
    };
    const queue = createWorkbenchTurnQueue({
      claims,
      publish: () => undefined,
    });

    await queue.run("wb", turn("m1", "one"), async () => undefined);

    expect(reportErrorCalls).toHaveLength(1);
    expect(reportErrorCalls[0]?.error).toBe(boom);
    expect(reportErrorCalls[0]?.context).toEqual({
      operation: "chat.turnQueue.drain",
      roomId: "wb",
    });
  });

  test("a throwing tryClaim on enqueue reclaim reports through reportError", async () => {
    const holders = new Map<string, string>();
    let n = 0;
    let tryClaimCalls = 0;
    const boom = new Error("reclaim connection reset");
    const claims: TurnClaimStore = {
      async tryClaim(c) {
        tryClaimCalls += 1;
        // First run wins. The second run's opening tryClaim sees the holder
        // and returns false (enqueue). Its follow-up reclaim tryClaim throws.
        if (tryClaimCalls === 1) {
          const t = String(++n);
          holders.set(c.workbenchId, t);
          return t;
        }
        if (tryClaimCalls === 2) return false;
        throw boom;
      },
      async release(c, t) {
        if (holders.get(c.workbenchId) !== t) return false;
        holders.delete(c.workbenchId);
        return true;
      },
      async holds(c, t) {
        return holders.get(c.workbenchId) === t;
      },
    };
    const queue = createWorkbenchTurnQueue({
      claims,
      publish: () => undefined,
    });
    let resolveFirst: (() => void) | undefined;
    let holdFirstDispatch = true;
    const first = queue.run("wb", turn("m1", "one"), () => {
      if (!holdFirstDispatch) return Promise.resolve();
      holdFirstDispatch = false;
      return new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });
    for (let i = 0; i < 20 && resolveFirst === undefined; i++) {
      await Promise.resolve();
    }
    expect(resolveFirst).toBeDefined();

    // In-flight claim: this run enqueues, then its reclaim tryClaim throws.
    await queue.run("wb", turn("m2", "two"), async () => undefined);

    expect(reportErrorCalls).toHaveLength(1);
    expect(reportErrorCalls[0]?.error).toBe(boom);
    expect(reportErrorCalls[0]?.context).toEqual({
      operation: "chat.turnQueue.enqueueReclaim",
      roomId: "wb",
    });

    resolveFirst?.();
    await first;
  });
});
