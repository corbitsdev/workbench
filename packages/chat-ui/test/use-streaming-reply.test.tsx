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
  let latestTimedOut = false;
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
      replyTimedOut,
      handleStreamEvent,
      noteAwaitingReply,
      resumeFromTurn,
    } = useStreamingReply(workbenchId, clearMs, minVisibleMs);
    latestState = streamingReply;
    latestTimedOut = replyTimedOut;
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
    timedOut: () => latestTimedOut,
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
    expect(harness.get()).toEqual({ text: "" });

    harness.send("chat.agent", delta("Hel"));
    expect(harness.get()).toEqual({ text: "Hel" });

    harness.send("chat.agent", delta("Hello"));
    expect(harness.get()).toEqual({ text: "Hello" });
    harness.unmount();
  });

  test("inference.done clears the reply once the turn ends", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", delta("Hello"));
    expect(harness.get()).toEqual({ text: "Hello" });

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
    expect(harness.get()).toEqual({ text: "Hello" });

    harness.switchWorkbench("chan_b");
    expect(harness.get()).toBeNull();
    harness.unmount();
  });

  test("noteAwaitingReply opens a pending reply after a send, and deltas take over", () => {
    const harness = mount("chan_a");
    harness.awaitReply();
    expect(harness.get()).toEqual({ text: "" });

    harness.send("chat.agent", delta("Hel"));
    expect(harness.get()).toEqual({ text: "Hel" });

    harness.awaitReply();
    expect(harness.get()).toEqual({ text: "Hel" });
    harness.unmount();
  });

  test("a chat.typing event never affects the streaming reply", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", delta("Hello"));
    harness.send("chat.typing", { principalId: "prn_other" });
    expect(harness.get()).toEqual({ text: "Hello" });
    harness.unmount();
  });
});

describe("useStreamingReply's reply-timeout backstop (CL-6252 #6)", () => {
  test("a pending reply with no tokens for the whole clearMs marks replyTimedOut", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    expect(harness.get()).toEqual({ text: "" });
    expect(harness.timedOut()).toBe(false);

    await harness.settle(60);
    expect(harness.get()).toBeNull();
    expect(harness.timedOut()).toBe(true);
    harness.unmount();
  });

  test("a token arriving before the backstop never marks it timed out", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    harness.send("chat.agent", delta("Hi"));

    await harness.settle(60);
    expect(harness.get()).toEqual({ text: "Hi" });
    expect(harness.timedOut()).toBe(false);
    harness.unmount();
  });

  test("switching workbenches clears a stale timed-out flag from the one just left", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    await harness.settle(60);
    expect(harness.timedOut()).toBe(true);

    harness.switchWorkbench("chan_b");
    expect(harness.timedOut()).toBe(false);
    harness.unmount();
  });

  test("noteAwaitingReply for a fresh turn clears a leftover timed-out flag", async () => {
    const harness = mount("chan_a", 30);
    harness.awaitReply();
    await harness.settle(60);
    expect(harness.timedOut()).toBe(true);

    harness.awaitReply();
    expect(harness.timedOut()).toBe(false);
    harness.unmount();
  });
});

describe("useStreamingReply.resumeFromTurn (CL-6380: catch-up on remount)", () => {
  test("hydrates the reply from a running turn's committed text on a fresh mount", () => {
    const harness = mount("chan_a");
    expect(harness.get()).toBeNull();

    harness.resumeFromTurn({ textSnapshot: "already streamed so far" });
    expect(harness.get()).toEqual({ text: "already streamed so far" });
    harness.unmount();
  });

  test("a running turn with no text yet opens the same empty pending pulse as noteAwaitingReply", () => {
    const harness = mount("chan_a");
    harness.resumeFromTurn({ textSnapshot: null });
    expect(harness.get()).toEqual({ text: "" });
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
    expect(harness.get()).toEqual({ text: "hi" });

    harness.resumeFromTurn(null);
    expect(harness.get()).toEqual({ text: "hi" });
    harness.unmount();
  });

  test("a live event that already opened the reply wins over a slower snapshot fetch", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", delta("live wins"));
    expect(harness.get()).toEqual({ text: "live wins" });

    harness.resumeFromTurn({ textSnapshot: "stale snapshot" });
    expect(harness.get()).toEqual({ text: "live wins" });
    harness.unmount();
  });
});

describe("useStreamingReply's typing-pulse floor", () => {
  test("a token arriving immediately still leaves the empty pulse up until minVisibleMs", async () => {
    const harness = mount("chan_a", undefined, 40);
    harness.awaitReply();
    expect(harness.get()).toEqual({ text: "" });

    harness.send("chat.agent", delta("Hi"));
    expect(harness.get()).toEqual({ text: "" });

    await harness.settle(60);
    expect(harness.get()).toEqual({ text: "Hi" });
    harness.unmount();
  });
});
