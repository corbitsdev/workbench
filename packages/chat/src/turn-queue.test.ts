import { describe, expect, test } from "bun:test";
import { createInMemoryTurnClaimStore } from "./turn-claims";
import type { TurnClaimStore } from "./turn-claims";
import { createWorkbenchTurnQueue, type QueuedTurn } from "./turn-queue";
import type { ChatWorkbenchEvent } from "./platform-port";

function turn(messageId: string, text: string): QueuedTurn {
  return {
    messageId,
    principalId: "prn_1",
    recipients: ["ins_echo1@acme.example"],
    parts: [{ kind: "text", text }],
  };
}

/** A controllable dispatcher: each call is held open until its `resolve`
 * is invoked, so a test can prove one turn is still running while a
 * second attempt would-be-overlap. */
function deferredDispatcher() {
  const calls: (readonly QueuedTurn[])[] = [];
  const resolvers: (() => void)[] = [];
  const dispatch = (batch: readonly QueuedTurn[]) => {
    calls.push(batch);
    return new Promise<void>((resolve) => resolvers.push(resolve));
  };
  return {
    calls,
    dispatch,
    resolveNext: () => resolvers.shift()?.(),
  };
}

describe("createWorkbenchTurnQueue", () => {
  test("a claimed workbench runs the turn immediately, as a batch of one", async () => {
    const events: ChatWorkbenchEvent[] = [];
    const queue = createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
      publish: (_workbenchId, event) => events.push(event),
    });

    const dispatched: (readonly QueuedTurn[])[] = [];
    await queue.run("wb_1", turn("msg_1", "hi"), async (batch) => {
      dispatched.push(batch);
    });

    expect(dispatched).toEqual([[turn("msg_1", "hi")]]);
    expect(events).toEqual([]);
  });

  test("a message arriving mid-turn queues and publishes chat.turn-queued", async () => {
    const events: ChatWorkbenchEvent[] = [];
    const queue = createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
      publish: (_workbenchId, event) => events.push(event),
    });
    const { dispatch, resolveNext } = deferredDispatcher();

    const firstRun = queue.run("wb_1", turn("msg_1", "one"), dispatch);
    // The second message's own run() call must observe the claim as
    // already held before the first turn's dispatch is ever resolved.
    await queue.run("wb_1", turn("msg_2", "two"), dispatch);

    expect(events).toEqual([
      {
        type: "chat.turn-queued",
        data: { workbenchId: "wb_1", messageId: "msg_2", queueLength: 1 },
      },
    ]);

    resolveNext(); // settles the first turn's own dispatch...
    // ...letting its continuation call `dispatch` again for the batched
    // turn the release then drains, before this test resolves that too.
    await Promise.resolve();
    await Promise.resolve();
    resolveNext();
    await firstRun;
  });

  test("everything queued behind an in-flight turn batches into ONE next turn, in arrival order", async () => {
    const queue = createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
      publish: () => undefined,
    });
    const { calls, dispatch, resolveNext } = deferredDispatcher();

    const firstRun = queue.run("wb_1", turn("msg_1", "one"), dispatch);
    await queue.run("wb_1", turn("msg_2", "two"), dispatch);
    await queue.run("wb_1", turn("msg_3", "three"), dispatch);

    // Only the first turn has actually dispatched so far — two and
    // three are still queued, not running concurrently with it.
    expect(calls).toEqual([[turn("msg_1", "one")]]);

    resolveNext(); // settles the first dispatch...
    // ...letting its continuation call `dispatch` again, batched, for
    // whatever queued behind it, before this test resolves that too.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([
      [turn("msg_1", "one")],
      [turn("msg_2", "two"), turn("msg_3", "three")],
    ]);

    resolveNext(); // settle the batched turn so nothing is left hanging
    await firstRun;
  });

  test("a failed dispatch still releases the claim and does not reject run()", async () => {
    const queue = createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
      publish: () => undefined,
    });

    // `dispatch` must never reject per its own documented contract; a
    // dispatch that breaks it is this queue's failure to contain, not
    // something that should propagate out of `run()`.
    await queue.run("wb_1", turn("msg_1", "one"), async () => {
      throw new Error("dispatch blew up");
    });

    // The claim was released despite the throw — a fresh turn can run.
    const dispatched: (readonly QueuedTurn[])[] = [];
    await queue.run("wb_1", turn("msg_2", "two"), async (batch) => {
      dispatched.push(batch);
    });
    expect(dispatched).toEqual([[turn("msg_2", "two")]]);
  });

  test("a rejecting dispatch does not strand what queued behind it", async () => {
    const queue = createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
      publish: () => undefined,
    });

    let rejectFirst: ((err: Error) => void) | undefined;
    const dispatched: string[] = [];
    const dispatch = (batch: readonly QueuedTurn[]): Promise<void> => {
      if (batch[0]?.messageId === "msg_1") {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      for (const t of batch) dispatched.push(t.messageId);
      return Promise.resolve();
    };

    const firstRun = queue.run("wb_1", turn("msg_1", "one"), dispatch);
    // msg_2 queues behind msg_1's still-open (and later rejecting) dispatch.
    await queue.run("wb_1", turn("msg_2", "two"), dispatch);

    rejectFirst?.(new Error("dispatch blew up"));
    await firstRun;

    expect(dispatched).toEqual(["msg_2"]);
  });

  // CL-7129: the TTL is a crash/hang backstop for a dispatch that never
  // settles at all, not a license for two loops to drain the same
  // workbench's queue at once. Reproduces the reported shape: a message
  // queues normally behind an in-flight turn, the TTL then elapses
  // while that turn is still open, a second `run()` wins a fresh claim
  // via the backstop and starts its own loop — and only ONE of the two
  // loops may ever go on to pop and dispatch the queued message.
  test("a claim's TTL expiring mid-dispatch stops the old loop from also draining what queued behind it", async () => {
    let now = 0;
    const claims = createInMemoryTurnClaimStore({
      ttlMs: 1_000,
      now: () => now,
    });
    const queue = createWorkbenchTurnQueue({
      claims,
      publish: () => undefined,
    });

    const calls: { batch: readonly QueuedTurn[]; resolve: () => void }[] = [];
    const dispatch = (batch: readonly QueuedTurn[]) =>
      new Promise<void>((resolve) => {
        calls.push({ batch, resolve });
      });

    // The first run() wins the claim and starts a turn that outlives
    // the claim TTL while still "in flight" — the crash/hang shape the
    // TTL backstop exists for.
    const firstRun = queue.run("wb_1", turn("msg_1", "a"), dispatch);
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    // A second message arrives before the TTL elapses: the first loop
    // is still the valid holder, so this queues normally.
    await queue.run("wb_1", turn("msg_2", "b"), dispatch);

    // The claim's TTL elapses while the first turn is still open.
    now += 1_000;

    // A third, unrelated run() for the same workbench now wins a fresh
    // claim via the TTL backstop and starts its own loop, dispatching
    // its own turn first.
    const thirdRun = queue.run("wb_1", turn("msg_3", "c"), dispatch);
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.batch).toEqual([turn("msg_3", "c")]);

    // The first loop's own dispatch finally settles. Before this fix,
    // it would go on to pop and dispatch "b" itself here — a second,
    // concurrent drain of the very queue the third loop now owns. The
    // fix's `holds` check makes it notice it lost the claim and stop.
    calls[0]?.resolve();
    await firstRun;
    expect(calls).toHaveLength(2);

    // The third loop's own dispatch settles next, picks up "b" (still
    // sitting in the shared queue, untouched by the first loop) exactly
    // once, and drains it under its own, still-valid claim.
    calls[1]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(3);
    expect(calls[2]?.batch).toEqual([turn("msg_2", "b")]);

    calls[2]?.resolve();
    await thirdRun;
  });

  test("workbenches never contend with each other", async () => {
    const queue = createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
      publish: () => undefined,
    });
    const { dispatch, resolveNext } = deferredDispatcher();

    const firstRun = queue.run("wb_1", turn("msg_1", "one"), dispatch);
    const dispatchedOther: (readonly QueuedTurn[])[] = [];
    await queue.run("wb_2", turn("msg_2", "two"), async (batch) => {
      dispatchedOther.push(batch);
    });

    expect(dispatchedOther).toEqual([[turn("msg_2", "two")]]);

    resolveNext();
    await firstRun;
  });
});

describe("turn queue drains everything that was enqueued", () => {
  test("does not strand a turn enqueued while the holder is releasing", async () => {
    const holders = new Map<string, string>();
    let n = 0;
    let onReleaseStart: (() => Promise<void>) | undefined;

    const claims: TurnClaimStore = {
      async tryClaim(c) {
        if (holders.has(c.workbenchId)) return false;
        const t = String(++n);
        holders.set(c.workbenchId, t);
        return t;
      },
      async release(c, t) {
        // A durable claim store awaits I/O here; anything can arrive first.
        const hook = onReleaseStart;
        onReleaseStart = undefined;
        if (hook) await hook();
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
    const dispatched: string[] = [];
    const dispatch = async (batch: readonly QueuedTurn[]) => {
      for (const t of batch) dispatched.push(t.messageId);
    };

    // m2 arrives after the drain loop saw an empty queue, before release lands.
    onReleaseStart = async () => {
      await queue.run("wb", turn("m2", "two"), dispatch);
    };

    await queue.run("wb", turn("m1", "one"), dispatch);
    await new Promise((r) => setTimeout(r, 20));

    expect(dispatched).toEqual(["m1", "m2"]);
  });

  // The symmetric half of the same race: the holder's `release()` can
  // resolve and its own post-release recheck can find nothing pending
  // *before* a concurrent enqueuer's failed `tryClaim` call ever
  // resolves — the enqueuer's push then lands only after the holder is
  // already gone and has already returned. Closing this requires the
  // enqueue path to reclaim on its own, not just the release path.
  test("does not strand a turn whose push lands only after the holder already returned", async () => {
    const holders = new Map<string, string>();
    let n = 0;
    let releaseBlockedClaim: (() => void) | undefined;

    const claims: TurnClaimStore = {
      async tryClaim(c) {
        if (holders.has(c.workbenchId)) {
          // Simulate a claim read that is still in flight (e.g. a slow
          // durable store) when the holder's own release already lands.
          await new Promise<void>((resolve) => {
            releaseBlockedClaim = resolve;
          });
          return false;
        }
        const t = String(++n);
        holders.set(c.workbenchId, t);
        return t;
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
    const dispatched: string[] = [];
    const dispatch = async (batch: readonly QueuedTurn[]) => {
      for (const t of batch) dispatched.push(t.messageId);
    };

    const firstRun = queue.run("wb", turn("m1", "one"), dispatch);
    const secondRun = queue.run("wb", turn("m2", "two"), dispatch);

    // m1 fully dispatches, sees nothing pending (m2's push hasn't
    // landed yet — its tryClaim call is still parked), and releases.
    await firstRun;
    expect(dispatched).toEqual(["m1"]);

    // Only now does m2's tryClaim resolve `false` and its push execute.
    releaseBlockedClaim?.();
    await secondRun;

    expect(dispatched).toEqual(["m1", "m2"]);
  });

  // CL-7195's own reasoning ("a durable store reopens the window")
  // implies these calls can also reject outright, not just resolve
  // `false` — a real possibility for I/O, unlike the in-memory store.
  // `run()` documents "never rejects", so the drain loop's claim-store
  // calls must not leak that rejection, and must still attempt to free
  // the claim rather than leaving it held until the TTL backstop.
  test("still releases the claim and does not reject run() when the claim store throws mid-drain", async () => {
    const holders = new Map<string, string>();
    let n = 0;
    let releaseCalls = 0;

    const claims: TurnClaimStore = {
      async tryClaim(c) {
        if (holders.has(c.workbenchId)) return false;
        const t = String(++n);
        holders.set(c.workbenchId, t);
        return t;
      },
      async release(c, t) {
        releaseCalls++;
        if (holders.get(c.workbenchId) !== t) return false;
        holders.delete(c.workbenchId);
        return true;
      },
      async holds() {
        throw new Error("claim store connection reset");
      },
    };

    const queue = createWorkbenchTurnQueue({
      claims,
      publish: () => undefined,
    });
    const dispatched: string[] = [];
    const dispatch = async (batch: readonly QueuedTurn[]) => {
      for (const t of batch) dispatched.push(t.messageId);
    };

    // Does not reject, despite `holds` throwing.
    await queue.run("wb", turn("m1", "one"), dispatch);

    expect(dispatched).toEqual(["m1"]);
    expect(releaseCalls).toBeGreaterThan(0);
    // The claim was freed despite the throw — a fresh turn can claim it
    // directly rather than only being queued.
    expect(holders.has("wb")).toBe(false);
  });
});
