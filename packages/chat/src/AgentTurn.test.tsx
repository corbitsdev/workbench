/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";

import { AgentTurn } from "./AgentTurn";
import { type ChatMessage } from "./types";

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

describe("AgentTurn", () => {
  it("gathers reasoning and tools into one activity block above the answer", () => {
    const message = agentMessage({
      reasoning: "I weighed the options",
      toolCalls: [
        {
          id: "c1",
          name: "attio__query_records",
          result: "[]",
          isError: false,
        },
      ],
    });
    const { container } = render(
      <AgentTurn
        message={message}
        formatToolSummary={() => "Searching Attio"}
      />,
    );
    // A single activity block wraps the whole trace.
    expect(screen.getAllByTestId("activity-block")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show activity" }));
    const text = container.textContent ?? "";
    const blockAt = text.indexOf("Searching Attio");
    const answerAt = text.indexOf("Final answer");
    expect(text.indexOf("I weighed the options")).toBeGreaterThanOrEqual(0);
    expect(blockAt).toBeGreaterThanOrEqual(0);
    // The answer follows the activity block.
    expect(answerAt).toBeGreaterThan(
      text.indexOf("I weighed the options"),
    );
  });

  it("keeps the activity block collapsed by default while streaming", () => {
    render(
      <AgentTurn
        message={agentMessage({
          content: "",
          reasoning: "Working through it",
          status: "sending",
        })}
      />,
    );
    expect(screen.queryByTestId("activity-reasoning")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Show activity" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("remembers expand via setReasoningExpanded", () => {
    const prefs = new Map<string, boolean>();
    const message = agentMessage({
      content: "",
      reasoning: "Working through it",
      status: "sending",
    });
    render(
      <AgentTurn
        message={message}
        isReasoningExpanded={(key) => prefs.get(key) === true}
        setReasoningExpanded={(key, expanded) => {
          if (expanded) prefs.set(key, true);
          else prefs.delete(key);
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show activity" }));
    expect(prefs.get("m1")).toBe(true);
    expect(screen.getByTestId("activity-reasoning").textContent).toContain(
      "Working through it",
    );
  });

  it("renders feedback once, after the activity block, keyed on feedbackId", async () => {
    const onRate = mock(() => Promise.resolve());
    const message = agentMessage({
      feedbackId: "t1",
      toolCalls: [
        {
          id: "c1",
          name: "attio__query_records",
          result: "[]",
          isError: false,
        },
      ],
    });
    const { container } = render(
      <AgentTurn
        message={message}
        formatToolSummary={() => "Searching Attio"}
        onRate={onRate}
        getRating={() => null}
      />,
    );
    const text = container.textContent ?? "";
    expect(screen.getAllByRole("button", { name: "Thumbs up" })).toHaveLength(
      1,
    );
    // Feedback footer comes after the activity block in DOM order.
    const block = container.querySelector('[data-testid="activity-block"]');
    const feedback = screen
      .getByRole("button", { name: "Thumbs up" })
      .closest("div");
    expect(block).not.toBeNull();
    expect(
      block!.compareDocumentPosition(feedback!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Thumbs down" }));
    // waitFor flushes the click's async rating state update inside act().
    await waitFor(() =>
      expect(onRate).toHaveBeenCalledWith("t1", "turn_part", -1),
    );
    expect(text.indexOf("Final answer")).toBeGreaterThanOrEqual(0);
  });

  it("reads the saved rating under feedbackId so a thumb survives the turn→mail collapse", () => {
    const getRating = mock((subjectId: string) =>
      subjectId === "t1" ? (1 as const) : null,
    );
    render(
      <AgentTurn
        message={agentMessage({ id: "a1", feedbackId: "t1" })}
        onRate={() => Promise.resolve()}
        getRating={getRating}
      />,
    );
    const up = screen.getByRole("button", { name: "Thumbs up" });
    expect(up.getAttribute("aria-pressed")).toBe("true");
    expect(getRating).toHaveBeenCalledWith("t1", "turn_part");
  });

  it("renders the sender label exactly once", () => {
    render(<AgentTurn message={agentMessage({ senderLabel: "Oat" })} />);
    expect(screen.getAllByText("From: Oat")).toHaveLength(1);
  });

  it("rolls a settled turn's tools into the collapsed block summary", () => {
    const message = agentMessage({
      toolCalls: [
        { id: "c1", name: "a", result: "1", isError: false },
        { id: "c2", name: "b", result: "2", isError: false },
        { id: "c3", name: "c", result: "3", isError: false },
      ],
    });
    render(
      <AgentTurn
        message={message}
        summarizeToolCalls={() => "Did three things"}
        formatToolSummary={() => "Tool"}
      />,
    );
    // The roll-up is the collapsed block summary; tool rows stay hidden until expanded.
    expect(screen.getByTestId("activity-summary").textContent).toBe(
      "Did three things",
    );
    expect(screen.getByTestId("activity-count").textContent).toContain(
      "3 tools",
    );
    expect(screen.queryByTestId("tool-row-summary")).toBeNull();
  });

  it("shows no feedback while the turn is still streaming", () => {
    render(
      <AgentTurn
        message={agentMessage({ status: "sending" })}
        onRate={() => Promise.resolve()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Thumbs up" })).toBeNull();
  });
});
