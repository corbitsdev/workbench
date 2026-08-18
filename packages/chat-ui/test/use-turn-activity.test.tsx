// Real React wiring for `useTurnActivity` + `TurnActivityStrip`, mounted
// against a DOM (see dom-setup.ts) the same way
// `test/use-streaming-reply.test.tsx` proves `useStreamingReply`'s effect
// wiring rather than reasoning about `nextTurnActivityState` alone — this
// proves a live tool call actually renders a chip, and that the strip
// clears itself once the turn ends.

import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { useTurnActivity, TurnActivityStrip } from "../src/turn-activity";

function mount(initialChannelId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let send: (eventType: string, data: unknown) => void = () => {};
  let setChannelId: (id: string | null) => void = () => {};

  function Host() {
    const [channelId, updateChannelId] = useState(initialChannelId);
    setChannelId = updateChannelId;
    const { activity, handleStreamEvent } = useTurnActivity(channelId);
    send = handleStreamEvent;
    return createElement(TurnActivityStrip, { activity });
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
    container,
    unmount: () => act(() => root.unmount()),
  };
}

describe("useTurnActivity + TurnActivityStrip (CL-6196: live wiring)", () => {
  test("a tool call in flight renders a running chip with its friendly label", () => {
    const harness = mount("chan_a");
    expect(harness.container.querySelector(".chat-turn-activity")).toBeNull();

    harness.send("chat.agent", {
      type: "inference.tool_call.start",
      seq: 1,
      data: { callId: "c1", name: "web_search", partial: { text: "" } },
    });

    const row = harness.container.querySelector(
      ".chat-turn-activity-row",
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.dataset.status).toBe("running");
    expect(row.textContent).toContain("web_search");
    harness.unmount();
  });

  test("mcp_read resolves to server.tool once inference.tool_call.end arrives", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", {
      type: "inference.tool_call.start",
      seq: 1,
      data: { callId: "c1", name: "mcp_read", partial: { text: "" } },
    });
    harness.send("chat.agent", {
      type: "inference.tool_call.end",
      seq: 2,
      data: {
        callId: "c1",
        name: "mcp_read",
        arguments: { server: "notion", tool: "search_pages" },
        partial: { text: "" },
      },
    });

    expect(harness.container.textContent).toContain("notion.search_pages");
    harness.unmount();
  });

  test("tool.done flips the chip to done, and the strip disappears once the turn ends", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", {
      type: "tool.start",
      seq: 1,
      data: { call: { id: "c1", name: "search", arguments: {} } },
    });
    harness.send("chat.agent", {
      type: "tool.done",
      seq: 2,
      data: { result: { callId: "c1", content: "ok" } },
    });

    const row = harness.container.querySelector(
      ".chat-turn-activity-row",
    ) as HTMLElement;
    expect(row.dataset.status).toBe("done");

    harness.send("chat.agent", {
      type: "inference.done",
      seq: 3,
      data: { turn: {}, usage: {}, source: "primary" },
    });
    expect(harness.container.querySelector(".chat-turn-activity")).toBeNull();
    harness.unmount();
  });

  test("a thinking delta renders the italic Thinking row", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", {
      type: "inference.thinking.delta",
      seq: 1,
      data: { token: "hmm", partial: { text: "", thinking: "hmm" } },
    });

    expect(
      harness.container.querySelector(".chat-turn-activity-thinking"),
    ).not.toBeNull();
    harness.unmount();
  });

  test("switching channels clears whatever activity was in flight in the one just left", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", {
      type: "tool.start",
      seq: 1,
      data: { call: { id: "c1", name: "search", arguments: {} } },
    });
    expect(
      harness.container.querySelector(".chat-turn-activity-row"),
    ).not.toBeNull();

    harness.switchChannel("chan_b");
    expect(harness.container.querySelector(".chat-turn-activity")).toBeNull();
    harness.unmount();
  });
});
