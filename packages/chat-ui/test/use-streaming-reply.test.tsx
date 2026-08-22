// Real React wiring for `useStreamingReply`, mounted against a DOM (see
// dom-setup.ts) rather than reasoned about via `nextStreamingReplyState`
// alone — the pure reducer is only "correct" if the effect around it
// actually resets on workbench switch, same as `use-typing-indicator.test.tsx`
// verifies for `useTypingIndicator`.

import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { useStreamingReply } from "../src/streaming-reply";
import type { StreamingReplyState } from "../src/streaming-reply";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(
  initialWorkbenchId: string | null,
  clearMs?: number,
  minVisibleMs = 0,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let latestState: StreamingReplyState = null;
  let latestTimedOutRefId: string | null = null;
  let send: (eventType: string, data: unknown) => void = () => {};
  let setWorkbenchId: (id: string | null) => void = () => {};
  let awaitReply: () => void = () => {};
  let resume: (
    runningTurn: { readonly textSnapshot: string | null } | null,
  ) => void = () => {};

  function Host() {
    const [workbenchId, updateWorkbenchId] = useState(initialWorkbenchId);
    setWorkbenchId = updateWorkbenchId;
    const {
      streamingReply,
      replyTimedOutRefId,
      handleStreamEvent,
      noteAwaitingReply,
      resumeFromTurn,
    } = useStreamingReply(workbenchId, clearMs, minVisibleMs);
    latestState = streamingReply;
    latestTimedOutRefId = replyTimedOutRefId;
    send = handleStreamEvent;
    awaitReply = noteAwaitingReply;
    resume = resumeFromTurn;
    return null;
  }

  act(() => {
    root.render(createElement(Host));
  });

  return {
    send: (eventType: string, data: unknown) =>
      act(() => {
        send(eventType, data);
      }),
    switchWorkbench: (id: string | null) =>
      act(() => {
        setWorkbenchId(id);
      }),
    awaitReply: () =>
      act(() => {
        awaitReply();
      }),
    resumeFromTurn: (
      runningTurn: { readonly textSnapshot: string | null } | null,
    ) =>
      act(() => {
        resume(runningTurn);
      }),
    settle: (ms: number) => act(() => sleep(ms)),
    get: () => latestState,
    timedOutRefId: () => latestTimedOutRefId,
    unmount: () => act(() => root.unmount()),
  };
}

function delta(text: string) {
  return {
    type: "inference.text.delta",
    seq: 1,
    data: { token: text.slice(-1), partial: { text } },
  };
}

describe("useStreamingReply (CL-6115: live wiring)", () => {
  test("start then deltas grow the reply text as events arrive", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", {
      type: "inference.start",
      seq: 0,
      data: { model: "x" },
    });
    expect(harness.get()).toEqual({ phase: "awaiting", text: "" });

    harness.send("chat.agent", delta("Hel"));
    expect(harness.get()).toEqual({ phase: "awaiting", text: "Hel" });

    harness.send("chat.agent", delta("Hello"));
    expect(harness.get()).toEqual({ phase: "awaiting", text: "Hello" });
    harness.unmount();
  });

  test("inference.done clears the reply once the turn ends", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", delta("Hello"));
    expect(harness.get()).toEqual({ phase: "awaiting", text: "Hello" });

    harness.send("chat.agent", {
      type: "inference.done",
      seq: 2,
      data: { turn: {}, usage: {}, source: "primary" },
    });
    expect(harness.get()).toBeNull();
    harness.unmount();
  });

  test("switching workbenches clears whatever was streaming in the one just left", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", delta("Hello"));
    expect(harness.get()).toEqual({ phase: "awaiting", text: "Hello" });

    harness.switchWorkbench("chan_b");
    expect(harness.get()).toBeNull();
    harness.unmount();
  });

  test("noteAwaitingReply opens a pending reply after a send, and deltas take over", () => {
    const harness = mount("chan_a");
    harness.awaitReply();
    expect(harness.get()).toEqual({ phase: "awaiting", text: "" });

    harness.send("chat.agent", delta("Hel"));
    expect(harness.get()).toEqual({ phase: "awaiting", text: "Hel" });

    harness.awaitReply();
    expect(harness.get()).toEqual({ phase: "awaiting", text: "Hel" });
    harness.unmount();
  });

  test("a chat.typing event never affects the streaming reply", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", delta("Hello"));
    harness.send("chat.typing", { principalId: "prn_other" });
    expect(harness.get()).toEqual({ phase: "awaiting", text: "Hello" });
    harness.unmount();
  });
});

describe("useStreamingReply's reply-timeout backstop (CL-6252 #6)", () => {
  test("a pending reply with no tokens for the whole clearMs mints a timed-out ref id", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    expect(harness.get()).toEqual({ phase: "awaiting", text: "" });
    expect(harness.timedOutRefId()).toBeNull();

    await harness.settle(60);
    expect(harness.get()).toBeNull();
    expect(harness.timedOutRefId()).not.toBeNull();
    harness.unmount();
  });

  // CL-6677: a cold-waking agent (a parked room re-deploying and
  // re-deriving its inference source, PR #327's defer-to-wake path) never
  // emits a single `chat.agent` event until it either replies or the
  // sidecar gives up — from this hook's perspective that is
  // indistinguishable from any other silent turn, so it must hit the
  // exact same backstop, ref id included, rather than a special ref-less
  // path of its own.
  test("a cold-waking room that never streams a single token still gets a quotable ref id", async () => {
    const harness = mount("chan_cold_wake", 30);
    harness.awaitReply();
    expect(harness.get()).toEqual({ phase: "awaiting", text: "" });

    await harness.settle(60);
    expect(harness.get()).toBeNull();
    const refId = harness.timedOutRefId();
    expect(refId).not.toBeNull();
    expect(refId).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    harness.unmount();
  });

  test("two separate timed-out turns mint two distinct ref ids", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    await harness.settle(60);
    const first = harness.timedOutRefId();
    expect(first).not.toBeNull();

    harness.awaitReply();
    await harness.settle(60);
    const second = harness.timedOutRefId();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    harness.unmount();
  });

  test("a token resets the backstop window instead of clearing it (CL-6486)", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    await harness.settle(20);
    // A token arrives just before the original deadline would have fired —
    // it must push the deadline out from here, not merely have prevented
    // the earlier one.
    harness.send("chat.agent", delta("Hi"));
    await harness.settle(20);
    expect(harness.get()).toEqual({ phase: "awaiting", text: "Hi" });
    expect(harness.timedOutRefId()).toBeNull();
    harness.unmount();
  });

  test("silence after a token still times out a mid-stream stall (CL-6486)", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    harness.send("chat.agent", delta("Hi"));
    expect(harness.get()).toEqual({ phase: "awaiting", text: "Hi" });

    // The model died mid-sentence: no further tokens, no terminal event.
    // The backstop must still fire off the last token, not stay armed
    // forever just because *some* text streamed.
    await harness.settle(60);
    expect(harness.get()).toBeNull();
    expect(harness.timedOutRefId()).not.toBeNull();
    harness.unmount();
  });

  test("switching workbenches clears a stale timed-out flag from the one just left", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    await harness.settle(60);
    expect(harness.timedOutRefId()).not.toBeNull();

    harness.switchWorkbench("chan_b");
    expect(harness.timedOutRefId()).toBeNull();
    harness.unmount();
  });

  test("noteAwaitingReply for a fresh turn clears a leftover timed-out flag", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    await harness.settle(60);
    expect(harness.timedOutRefId()).not.toBeNull();

    harness.awaitReply();
    expect(harness.timedOutRefId()).toBeNull();
    harness.unmount();
  });
});

describe("useStreamingReply (CL-false-no-reply: the notice must never fire once a reply has rendered)", () => {
  const MYRA_ADDRESS = "myra@agents.example";

  test("a full reply renders and the run then goes quiet with no terminal event (parked folded run) — no notice", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    harness.send("chat.agent", delta("Full answer."));
    // The persisted reply posts as its own chat.message — the real signal
    // the reader sees on screen — entirely independent of whichever
    // chat.agent event (or none, if this run parks) follows it.
    harness.send("chat.message", {
      id: "msg_1",
      sender: { name: null, address: MYRA_ADDRESS },
      parts: [{ kind: "text", text: "Full answer." }],
    });
    expect(harness.get()).toEqual({ phase: "replied" });

    // No message.run.ended, no connector.reply — mimics a folded run that
    // parks instead of ending. The backstop must not have armed for a
    // "replied" phase, so it must never fire.
    await harness.settle(60);
    expect(harness.timedOutRefId()).toBeNull();
    harness.unmount();
  });

  test("a full reply renders and then a post-reply tool round runs — no notice", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    harness.send("chat.agent", delta("Full answer."));
    harness.send("chat.message", {
      id: "msg_1",
      sender: { name: null, address: MYRA_ADDRESS },
      parts: [{ kind: "text", text: "Full answer." }],
    });

    // A memory-write tool round after the reply — must stay inert.
    harness.send("chat.agent", {
      type: "inference.start",
      seq: 10,
      data: { model: "x" },
    });
    harness.send("chat.agent", {
      type: "inference.done",
      seq: 11,
      data: { turn: {}, usage: {}, source: "primary" },
    });

    await harness.settle(60);
    expect(harness.get()).toEqual({ phase: "replied" });
    expect(harness.timedOutRefId()).toBeNull();
    harness.unmount();
  });

  test("a turn that never produces any content still times out after the backstop window", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    expect(harness.get()).toEqual({ phase: "awaiting", text: "" });

    await harness.settle(60);
    expect(harness.get()).toBeNull();
    expect(harness.timedOutRefId()).not.toBeNull();
    harness.unmount();
  });
});

describe("useStreamingReply.resumeFromTurn (CL-6380: catch-up on remount)", () => {
  test("hydrates the reply from a running turn's committed text on a fresh mount", () => {
    const harness = mount("chan_a");
    expect(harness.get()).toBeNull();

    harness.resumeFromTurn({ textSnapshot: "already streamed so far" });
    expect(harness.get()).toEqual({
      phase: "awaiting",
      text: "already streamed so far",
    });
    harness.unmount();
  });

  test("a running turn with no text yet opens the same empty pending pulse as noteAwaitingReply", () => {
    const harness = mount("chan_a");
    harness.resumeFromTurn({ textSnapshot: null });
    expect(harness.get()).toEqual({ phase: "awaiting", text: "" });
    harness.unmount();
  });

  test("no running turn is a no-op, not a reset", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", {
      type: "inference.start",
      seq: 0,
      data: { model: "x" },
    });
    harness.send("chat.agent", delta("hi"));
    expect(harness.get()).toEqual({ phase: "awaiting", text: "hi" });

    harness.resumeFromTurn(null);
    expect(harness.get()).toEqual({ phase: "awaiting", text: "hi" });
    harness.unmount();
  });

  test("a live event that already opened the reply wins over a slower snapshot fetch", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", delta("live wins"));
    expect(harness.get()).toEqual({ phase: "awaiting", text: "live wins" });

    harness.resumeFromTurn({ textSnapshot: "stale snapshot" });
    expect(harness.get()).toEqual({ phase: "awaiting", text: "live wins" });
    harness.unmount();
  });
});

describe("useStreamingReply's typing-pulse floor", () => {
  test("a token arriving immediately still leaves the empty pulse up until minVisibleMs", async () => {
    const harness = mount("chan_a", undefined, 40);
    harness.awaitReply();
    expect(harness.get()).toEqual({ phase: "awaiting", text: "" });

    harness.send("chat.agent", delta("Hi"));
    expect(harness.get()).toEqual({ phase: "awaiting", text: "" });

    await harness.settle(60);
    expect(harness.get()).toEqual({ phase: "awaiting", text: "Hi" });
    harness.unmount();
  });
});
