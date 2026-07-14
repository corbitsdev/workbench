/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { AgentTurn } from "./AgentTurn";
import { ChatThread } from "./ChatThread";
import { type ChatMessage, type ToolCall } from "./types";
import {
  CHAT_RESPONSE_STACK,
  CHAT_THREAD_TURN_GAP,
  CHAT_TURN_STACK,
} from "./messageRhythm";

afterEach(() => {
  cleanup();
});

function agentMessage(extra?: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "agent",
    content: "Final answer",
    createdAt: "2026-06-04T00:01:00Z",
    ...extra,
  };
}

const manyTools: ToolCall[] = [
  { id: "c1", name: "exa__search", result: "[]", isError: false },
  { id: "c2", name: "attio__query_records", result: "[]", isError: false },
  { id: "c3", name: "attio__create_note", result: "ok", isError: false },
  { id: "c4", name: "firecrawl__scrape", result: "ok", isError: false },
  { id: "c5", name: "linear__list_issues", result: "[]", isError: false },
];

describe("transcript spacing scale", () => {
  it("long research turn: turn/response stacks use the documented tokens, no orphan gaps", () => {
    const message = agentMessage({
      reasoning:
        "Checking Attio for existing records\nDrafting a summary of findings",
      toolCalls: manyTools,
      content: "Here is the research summary with several findings.",
    });
    const { container } = render(
      <AgentTurn message={message} formatToolSummary={() => "Searching"} />,
    );

    const turn = container.querySelector('[data-testid="agent-turn"]');
    expect(turn).not.toBeNull();
    expect(turn!.className).toContain(CHAT_TURN_STACK);

    fireEvent.click(screen.getByRole("button", { name: "Show activity" }));
    const detail = screen.getByTestId("activity-detail");
    expect(detail.className).toBe(CHAT_RESPONSE_STACK);

    // Every tool row renders through the shared narrative — no bare/unstyled
    // rows outside the tool-narrative container.
    const narrative = screen.getByTestId("tool-narrative");
    expect(
      narrative.querySelectorAll('[data-testid="tool-row-summary"]'),
    ).toHaveLength(manyTools.length);

    // No fixed-height placeholders anywhere in the rendered turn (a giant gap
    // regression shows up as a hardcoded h-* on an otherwise-empty container).
    const fixedHeightNodes = Array.from(
      container.querySelectorAll("[class*='h-96'], [class*='h-screen']"),
    );
    expect(fixedHeightNodes).toHaveLength(0);
  });

  it("short greeting turn: no activity block, single turn stack, no trailing empty gap", () => {
    const message = agentMessage({ content: "Hi! How can I help today?" });
    const { container } = render(<AgentTurn message={message} />);

    expect(screen.queryByTestId("activity-block")).toBeNull();
    const turn = container.querySelector('[data-testid="agent-turn"]');
    expect(turn).not.toBeNull();
    expect(turn!.className).toContain(CHAT_TURN_STACK);
    // Only the bubble renders as a child — no empty activity/feedback spacer.
    expect(turn!.children.length).toBe(1);
  });

  it("ChatThread applies the larger inter-turn gap distinct from any intra-turn gap", () => {
    const messages: ChatMessage[] = [
      agentMessage({ id: "g1", content: "Hi there" }),
      agentMessage({
        id: "g2",
        content: "Second turn",
        createdAt: "2026-06-04T00:02:00Z",
        reasoning: "Thinking it over",
        toolCalls: [manyTools[0]!],
      }),
    ];
    const { container } = render(<ChatThread messages={messages} />);
    const log = container.querySelector('[role="log"]');
    expect(log).not.toBeNull();
    expect(log!.className).toContain(CHAT_THREAD_TURN_GAP);
    expect(CHAT_THREAD_TURN_GAP).not.toBe(CHAT_TURN_STACK);
  });
});
