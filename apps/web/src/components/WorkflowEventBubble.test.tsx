import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorkflowRunEvent } from "../lib/run-events";

const focusCalls: string[] = [];
mock.module("../lib/dock-focus", () => ({
  requestDockFocus: (runId: string) => focusCalls.push(runId),
  useDockFocus: () => null,
}));

const { WorkflowEventBubble } = await import("./WorkflowEventBubble");

afterEach(cleanup);

function event(over: Partial<WorkflowRunEvent> = {}): WorkflowRunEvent {
  return {
    id: "run-abc123def456:0",
    runId: "run-abc123def456",
    kind: "brief",
    state: "started",
    summary: "Started brief",
    at: "2026-07-03T12:00:00.000Z",
    ...over,
  };
}

describe("WorkflowEventBubble", () => {
  it("renders as a distinct workflow-event bubble, not an agent message", () => {
    render(<WorkflowEventBubble event={event()} />);
    const bubble = screen.getByTestId("workflow-event-bubble");
    // Addressed to its run so it can never be mistaken for Myra's voice.
    expect(bubble.closest("[data-role='workflow-event']")).not.toBeNull();
    expect(bubble.getAttribute("data-run-id")).toBe("run-abc123def456");
  });

  it("names the run (kind + short id) so concurrent runs never blur", () => {
    const runId = "run-0123456789abcdef0123456789abcdef";
    render(<WorkflowEventBubble event={event({ kind: "deck", runId })} />);
    screen.getByText("deck");
    // Short id, truncated to 16 chars with an ellipsis (enough entropy that two
    // concurrent runs cannot collide on the label).
    screen.getByText(new RegExp(`${runId.slice(0, 16)}…`));
  });

  it("a gate-awaiting event makes clear the named run needs input", () => {
    render(
      <WorkflowEventBubble
        event={event({
          state: "gate-awaiting",
          summary: "brief needs your input",
        })}
      />,
    );
    screen.getByText("Needs you");
    screen.getByText("brief needs your input");
  });

  it("escalates urgency for events that need attention, stays polite otherwise", () => {
    const { rerender } = render(<WorkflowEventBubble event={event()} />);
    // A benign "started" is announced politely.
    let bubble = screen.getByTestId("workflow-event-bubble");
    expect(bubble.getAttribute("aria-live")).toBe("polite");
    expect(bubble.getAttribute("role")).toBe("status");

    // A failed run interrupts (assertive).
    rerender(<WorkflowEventBubble event={event({ state: "failed" })} />);
    bubble = screen.getByTestId("workflow-event-bubble");
    expect(bubble.getAttribute("aria-live")).toBe("assertive");
    expect(bubble.getAttribute("role")).toBe("alert");

    // A run that now needs the operator also interrupts.
    rerender(<WorkflowEventBubble event={event({ state: "gate-awaiting" })} />);
    expect(
      screen.getByTestId("workflow-event-bubble").getAttribute("aria-live"),
    ).toBe("assertive");
  });

  it("'Open in dock' requests focus for this run's card", () => {
    focusCalls.length = 0;
    render(<WorkflowEventBubble event={event()} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Open brief .* in dock/ }),
    );
    expect(focusCalls).toEqual(["run-abc123def456"]);
  });
});
