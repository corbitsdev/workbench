// The composer-adjacent "N is/are typing…" line for in-flight agent
// streams: renders nothing for zero names, and mini avatars + the right
// CHAT_STRINGS.agentsTyping copy for one, two, and three-or-more.

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
      container.querySelector(".chat-agent-typing-indicator > span:last-child")
        ?.textContent,
    unmount: () => root.unmount(),
  };
}

describe("AgentTypingIndicator", () => {
  test("renders nothing when no agent is streaming", () => {
    const { container, unmount } = render([]);
    expect(container.querySelector(".chat-agent-typing-indicator")).toBeNull();
    unmount();
  });

  test("one agent reads as a single typist with one avatar", () => {
    const { container, label, unmount } = render(["Myra"]);
    expect(label()).toBe("Myra is typing…");
    expect(
      container.querySelectorAll(".chat-agent-typing-avatar"),
    ).toHaveLength(1);
    unmount();
  });

  test("two agents are joined with 'and'", () => {
    const { container, label, unmount } = render(["Myra", "Scribe"]);
    expect(label()).toBe("Myra and Scribe are typing…");
    expect(
      container.querySelectorAll(".chat-agent-typing-avatar"),
    ).toHaveLength(2);
    unmount();
  });

  test("three or more collapse into 'and N others'", () => {
    const { label, unmount } = render(["Myra", "Scribe", "Tally"]);
    expect(label()).toBe("Myra, Scribe and 1 other are typing…");
    unmount();
  });
});
