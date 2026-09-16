// The incoming-slot pulse for in-flight agent streams: renders nothing
// for zero names, and a dots bubble whose hidden live-region copy
// matches CHAT_STRINGS.agentsTyping for one, two, and three-or-more.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { AgentTypingIndicator } from "../src/typing-indicator";

function render(names: readonly string[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(AgentTypingIndicator, { names }));
  });
  return {
    container,
    label: () =>
      container.querySelector(".chat-typing-indicator-label")?.textContent,
    unmount: () => act(() => root.unmount()),
  };
}

describe("AgentTypingIndicator", () => {
  test("renders nothing when no agent is streaming", () => {
    const { container, unmount } = render([]);
    expect(container.querySelector(".chat-silk-thinking-indicator")).toBeNull();
    unmount();
  });

  test("one agent renders the branded Silk thinking state", () => {
    const { container, label, unmount } = render(["Myra"]);
    expect(label()).toBe("Myra is typing…");
    expect(
      container.querySelector(".chat-silk-thinking-indicator"),
    ).not.toBeNull();
    expect(
      container.querySelector(".chat-silk-thinking-mark-base"),
    ).not.toBeNull();
    expect(
      container.querySelector(".chat-silk-thinking-mark-active"),
    ).not.toBeNull();
    expect(container.querySelector(".chat-silk-beam-x")).not.toBeNull();
    expect(
      container.querySelector(".chat-silk-thinking-text")?.textContent,
    ).toBe("Thinking…");
    expect(
      container.querySelector(".chat-typing-row")?.getAttribute("data-own"),
    ).toBe("false");
    unmount();
  });

  test("two agents are joined with 'and'", () => {
    const { label, unmount } = render(["Myra", "Scribe"]);
    expect(label()).toBe("Myra and Scribe are typing…");
    unmount();
  });

  test("three or more collapse into 'and N others'", () => {
    const { label, unmount } = render(["Myra", "Scribe", "Tally"]);
    expect(label()).toBe("Myra, Scribe and 1 other are typing…");
    unmount();
  });
});
