import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ConversationWorkflowRun } from "./use-workflow";

let runs: ConversationWorkflowRun[] = [];
mock.module("./use-workflow", () => ({
  useConversationWorkflowRuns: () => ({ data: runs }),
}));

const { useWorkflowRunEvents } = await import("./use-workflow-run-events");

function row(
  runId: string,
  status: ConversationWorkflowRun["status"],
  kind = "brief",
): ConversationWorkflowRun {
  return {
    runId,
    kind,
    status,
    createdAt: "2026-07-03T00:00:00.000Z",
    originConversationId: "conv-1",
  };
}

function Harness({ conversationId }: { conversationId: string | null }) {
  const events = useWorkflowRunEvents(conversationId, null);
  return (
    <ul>
      {events.map((e) => (
        <li key={e.id} data-testid="event">
          {e.runId}:{e.state}
        </li>
      ))}
    </ul>
  );
}

afterEach(cleanup);

describe("useWorkflowRunEvents", () => {
  it("seeds silently, then emits transition events on later polls", async () => {
    runs = [row("r1", "running")];
    const { rerender } = render(<Harness conversationId="conv-1" />);
    // First observation seeds the baseline — no replayed history.
    await waitFor(() =>
      expect(screen.queryAllByTestId("event")).toHaveLength(0),
    );

    runs = [row("r1", "awaiting")];
    rerender(<Harness conversationId="conv-1" />);
    await waitFor(() => screen.getByText("r1:gate-awaiting"));

    runs = [row("r1", "completed")];
    rerender(<Harness conversationId="conv-1" />);
    await waitFor(() => screen.getByText("r1:completed"));
    // Both events accumulate in the thread.
    expect(screen.queryAllByTestId("event")).toHaveLength(2);
  });

  it("keeps two concurrent runs separate without cross-talk", async () => {
    runs = [row("r1", "running"), row("r2", "running", "deck")];
    const { rerender } = render(<Harness conversationId="conv-2" />);
    await waitFor(() =>
      expect(screen.queryAllByTestId("event")).toHaveLength(0),
    );

    runs = [row("r1", "awaiting"), row("r2", "completed", "deck")];
    rerender(<Harness conversationId="conv-2" />);
    await waitFor(() =>
      expect(screen.queryAllByTestId("event")).toHaveLength(2),
    );
    screen.getByText("r1:gate-awaiting");
    screen.getByText("r2:completed");
  });

  it("clears and reseeds without replay when the conversation changes", async () => {
    runs = [row("r1", "running")];
    const { rerender } = render(<Harness conversationId="conv-a" />);
    await waitFor(() =>
      expect(screen.queryAllByTestId("event")).toHaveLength(0),
    );

    runs = [row("r1", "completed")];
    rerender(<Harness conversationId="conv-a" />);
    await waitFor(() =>
      expect(screen.queryAllByTestId("event")).toHaveLength(1),
    );

    // Switching conversation resets the log and reseeds the new conversation's
    // pre-existing runs silently — no "started" replay for runs already running.
    runs = [row("r2", "running", "deck")];
    rerender(<Harness conversationId="conv-b" />);
    await waitFor(() =>
      expect(screen.queryAllByTestId("event")).toHaveLength(0),
    );

    runs = [row("r2", "completed", "deck")];
    rerender(<Harness conversationId="conv-b" />);
    await waitFor(() => screen.getByText("r2:completed"));
    expect(screen.queryAllByTestId("event")).toHaveLength(1);
  });
});
