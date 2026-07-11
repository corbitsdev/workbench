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
  it("renders the process trace (reasoning, then tools) before the answer", () => {
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
    const text = container.textContent ?? "";
    const reasoningAt = text.indexOf("Reasoning");
    const toolAt = text.indexOf("Searching Attio");
    const answerAt = text.indexOf("Final answer");
    expect(reasoningAt).toBeGreaterThanOrEqual(0);
    expect(toolAt).toBeGreaterThan(reasoningAt);
    expect(answerAt).toBeGreaterThan(toolAt);
  });

  it("auto-opens reasoning while it streams and collapses when the answer starts", () => {
    const streaming = agentMessage({
      content: "",
      reasoning: "Working through it",
      status: "sending",
    });
    const { rerender } = render(<AgentTurn message={streaming} />);
    // Open without a click while reasoning is the only live content.
    expect(screen.getByText("Working through it")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: /Reasoning/i })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    rerender(
      <AgentTurn
        message={agentMessage({
          content: "Answer streaming",
          reasoning: "Working through it",
          status: "sending",
        })}
      />,
    );
    // Answer text arrived: the disclosure collapses back to its label.
    expect(
      screen
        .getByRole("button", { name: /Reasoning/i })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("a manual toggle sticks over the auto behavior", () => {
    const message = agentMessage({
      content: "",
      reasoning: "Working through it",
      status: "sending",
    });
    render(<AgentTurn message={message} />);
    fireEvent.click(screen.getByRole("button", { name: /Reasoning/i }));
    expect(
      screen
        .getByRole("button", { name: /Reasoning/i })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("renders feedback once, after the tool narrative, keyed on feedbackId", async () => {
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
    // Feedback footer comes after the narrative content in DOM order.
    const narrative = container.querySelector('[data-testid="tool-narrative"]');
    const feedback = screen
      .getByRole("button", { name: "Thumbs up" })
      .closest("div");
    expect(narrative).not.toBeNull();
    expect(
      narrative!.compareDocumentPosition(feedback!) &
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
