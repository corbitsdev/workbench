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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(initialWorkbenchId: string | null, staleMs?: number) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let send: (eventType: string, data: unknown) => void = () => {};
  let setWorkbenchId: (id: string | null) => void = () => {};

  function Host() {
    const [workbenchId, updateWorkbenchId] = useState(initialWorkbenchId);
    setWorkbenchId = updateWorkbenchId;
    const { activity, handleStreamEvent } = useTurnActivity(
      workbenchId,
      staleMs,
    );
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
    switchWorkbench: (id: string | null) =>
      act(() => {
        setWorkbenchId(id);
      }),
    settle: (ms: number) => act(() => sleep(ms)),
    container,
    unmount: () => act(() => root.unmount()),
  };
}

describe("useTurnActivity + TurnActivityStrip (CL-6196: live wiring)", () => {
  test("a tool call in flight renders a running row phrased in the present tense", () => {
    const harness = mount("chan_a");
    expect(harness.container.querySelector(".chat-tool-activity")).toBeNull();

    harness.send("chat.agent", {
      type: "inference.tool_call.start",
      seq: 1,
      data: { callId: "c1", name: "web_search", partial: { text: "" } },
    });

    const row = harness.container.querySelector(
      ".chat-tool-activity-row",
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(
      row
        .querySelector(".chat-tool-activity-marker")
        ?.getAttribute("data-status"),
    ).toBe("running");
    expect(row.textContent).toContain("Searching the web");
    expect(row.textContent).not.toContain("web_search");
    harness.unmount();
  });

  test("an MCP dispatch call reads as the tool it actually invoked once its arguments arrive", () => {
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

    expect(harness.container.textContent).toContain(
      "Searching pages in Notion",
    );
    harness.unmount();
  });

  test("tool.done settles the row, and the strip disappears once the turn ends", () => {
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
      ".chat-tool-activity-row",
    ) as HTMLElement;
    expect(
      row
        .querySelector(".chat-tool-activity-marker")
        ?.getAttribute("data-status"),
    ).toBe("success");

    harness.send("chat.agent", {
      type: "inference.done",
      seq: 3,
      data: { turn: {}, usage: {}, source: "primary" },
    });
    expect(harness.container.querySelector(".chat-tool-activity")).toBeNull();
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
      harness.container.querySelector(".chat-tool-activity-thinking"),
    ).not.toBeNull();
    harness.unmount();
  });

  test("switching workbenches clears whatever activity was in flight in the one just left", () => {
    const harness = mount("chan_a");
    harness.send("chat.agent", {
      type: "tool.start",
      seq: 1,
      data: { call: { id: "c1", name: "search", arguments: {} } },
    });
    expect(
      harness.container.querySelector(".chat-tool-activity-row"),
    ).not.toBeNull();

    harness.switchWorkbench("chan_b");
    expect(harness.container.querySelector(".chat-tool-activity")).toBeNull();
    harness.unmount();
  });

  test("a stale turn with no terminal event clears itself after the backstop", async () => {
    const harness = mount("chan_a", 30);
    harness.send("chat.agent", {
      type: "tool.start",
      seq: 1,
      data: { call: { id: "c1", name: "search", arguments: {} } },
    });
    expect(
      harness.container.querySelector(".chat-tool-activity"),
    ).not.toBeNull();

    // No `tool.done`/`reactor.done` ever arrives — a dropped SSE mid-turn.
    await harness.settle(60);
    expect(harness.container.querySelector(".chat-tool-activity")).toBeNull();
    harness.unmount();
  });

  test("a fresh event re-arms the backstop instead of clearing on its own clock", async () => {
    const harness = mount("chan_a", 30);
    harness.send("chat.agent", {
      type: "tool.start",
      seq: 1,
      data: { call: { id: "c1", name: "search", arguments: {} } },
    });

    await harness.settle(20);
    harness.send("chat.agent", {
      type: "inference.tool_call.start",
      seq: 2,
      data: { callId: "c2", name: "web_search" },
    });
    await harness.settle(20);
    expect(
      harness.container.querySelector(".chat-tool-activity"),
    ).not.toBeNull();

    await harness.settle(30);
    expect(harness.container.querySelector(".chat-tool-activity")).toBeNull();
    harness.unmount();
  });
});
