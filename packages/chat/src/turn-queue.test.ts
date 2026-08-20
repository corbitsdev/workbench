import { describe, expect, test } from "bun:test";
import { createInMemoryTurnClaimStore } from "./turn-claims";
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

  test("a failed dispatch still releases the claim", async () => {
    const queue = createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
      publish: () => undefined,
    });

    await expect(
      queue.run("wb_1", turn("msg_1", "one"), async () => {
        throw new Error("dispatch blew up");
      }),
    ).rejects.toThrow("dispatch blew up");

    // The claim was released despite the throw — a fresh turn can run.
    const dispatched: (readonly QueuedTurn[])[] = [];
    await queue.run("wb_1", turn("msg_2", "two"), async (batch) => {
      dispatched.push(batch);
    });
    expect(dispatched).toEqual([[turn("msg_2", "two")]]);
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
