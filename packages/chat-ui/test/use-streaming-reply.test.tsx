// Real React wiring for `useStreamingReply`, mounted against a DOM (see
// dom-setup.ts) rather than reasoned about via `nextStreamingReplyState`
// alone — the pure reducer is only "correct" if the effect around it
// actually resets on channel switch, same as `use-typing-indicator.test.tsx`
// verifies for `useTypingIndicator`.

import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { useStreamingReply } from "../src/streaming-reply";
import type { StreamingReplyState } from "../src/streaming-reply";

function mount(initialChannelId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let latestState: StreamingReplyState = null;
  let send: (eventType: string, data: unknown) => void = () => {};
  let setChannelId: (id: string | null) => void = () => {};

  function Host() {
    const [channelId, updateChannelId] = useState(initialChannelId);
    setChannelId = updateChannelId;
    const { streamingReply, handleStreamEvent } = useStreamingReply(channelId);
    latestState = streamingReply;
    send = handleStreamEvent;
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
    switchChannel: (id: string | null) =>
      act(() => {
        setChannelId(id);
      }),
    get: () => latestState,
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

  test("switching channels clears whatever was streaming in the one just left", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", delta("Hello"));
    expect(harness.get()).toEqual({ text: "Hello" });

    harness.switchChannel("chan_b");
    expect(harness.get()).toBeNull();
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
