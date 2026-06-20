import { describe, expect, it, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RunState } from "@intx/workflow";
import { Panel } from "./ui";

type StepPhase =
  | "in-flight"
  | "awaiting-signal"
  | "awaiting-timer"
  | "completed"
  | "failed"
  | "cancelled";

function makeState(
  phases: Record<string, StepPhase>,
  runPhase: RunState["phase"] = "running",
): RunState {
  const steps = new Map<
    string,
    { stepId: string; phase: StepPhase; currentAttempt: number }
  >();
  for (const [stepId, phase] of Object.entries(phases)) {
    steps.set(stepId, { stepId, phase, currentAttempt: 1 });
  }
  return {
    runId: "run_test",
    phase: runPhase,
    lastSeq: 0,
    steps,
    children: new Map(),
    pendingTimers: new Map(),
    observedSignalIds: new Set(),
    unconsumedSignals: new Map(),
    consumedMessageIds: new Set(),
  } as unknown as RunState;
}

const noop = () => {};

describe("gamma-presentation-creator Panel", () => {
  it("renders the template form from the list-templates output and submits the brief via onSignal", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ template: "awaiting-signal" })}
        connected
        stepOutputs={{
          "list-templates": {
            templates: [
              { gammaId: "tmpl_pro", name: "Investor Deck", systemPrompt: "x" },
            ],
          },
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    screen.getByText("Set up the deck");
    await userEvent.type(screen.getByLabelText("Audience"), "Investors");
    await userEvent.type(screen.getByLabelText("Tone"), "Confident");
    await userEvent.type(screen.getByLabelText("Goal"), "Close round");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(onSignal).toHaveBeenCalledWith("template", {
      gammaId: "tmpl_pro",
      templateId: "tmpl_pro",
      audience: "Investors",
      tone: "Confident",
      goal: "Close round",
    });
  });

  it("does not submit the template form without a goal", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ template: "awaiting-signal" })}
        connected
        stepOutputs={{
          "list-templates": {
            templates: [
              { gammaId: "tmpl_pro", name: "Deck", systemPrompt: "x" },
            ],
          },
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("renders the Granola call list and emits a noteId on selection", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          template: "completed",
          "source-selection": "awaiting-signal",
        })}
        connected
        stepOutputs={{
          "list-notes": {
            notes: [
              { id: "note_1", title: "Acme discovery call" },
              { id: "note_2", title: "Globex demo" },
            ],
            hasMore: false,
          },
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Globex demo" }));
    expect(onSignal).toHaveBeenCalledWith("source-selection", {
      noteId: "note_2",
    });
  });

  it("shows an empty-state when no Granola calls are available", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          template: "completed",
          "source-selection": "awaiting-signal",
        })}
        connected
        stepOutputs={{ "list-notes": { notes: [], hasMore: false } }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("No Granola calls available.");
  });

  it("renders brief content resolved from template and source step outputs", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          template: "completed",
          source: "completed",
          generate: "in-flight",
        })}
        connected
        stepOutputs={{
          template: {
            gammaId: "tmpl_pro",
            audience: "Investors",
            tone: "Confident",
            goal: "Close round",
          },
          source: { title: "Acme discovery call", summary: "Discovery" },
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("tmpl_pro");
    screen.getByText("Investors");
    screen.getByText("Confident");
    screen.getByText("Close round");
    screen.getByText("Acme discovery call");
  });

  it("marks completed steps done and the awaiting-signal review step current", () => {
    const { container } = render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          template: "completed",
          source: "completed",
          generate: "completed",
          review: "awaiting-signal",
        })}
        connected
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    const indicators = Array.from(container.querySelectorAll(".rounded-full"));
    const labels = indicators.map((el) => el.textContent);
    expect(labels.slice(0, 3)).toEqual(["✓", "✓", "✓"]);
    expect(labels[3]).toBe("4");
    screen.getByText("Review the draft");
  });

  it("fires onSignal review-approval when Approve is clicked during awaiting-signal review", async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          template: "completed",
          source: "completed",
          generate: "completed",
          review: "awaiting-signal",
        })}
        connected
        stepOutputs={{}}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onSignal).toHaveBeenCalledWith("review-approval", {
      approved: true,
    });
  });

  it("does not show Approve when review is not awaiting a signal", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ template: "completed", source: "in-flight" })}
        connected
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("renders the https Gamma deck once render completes", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState(
          {
            template: "completed",
            source: "completed",
            generate: "completed",
            review: "completed",
            render: "completed",
          },
          "completed",
        )}
        connected
        stepOutputs={{
          render: {
            callId: "det-render",
            content: JSON.stringify({
              gammaUrl: "https://gamma.app/docs/deck-123",
            }),
          },
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    const frame = screen.getByTitle("Generated Gamma presentation");
    expect(frame.getAttribute("src")).toBe("https://gamma.app/docs/deck-123");
    expect(
      screen.getByRole("link", { name: "Open in Gamma" }).getAttribute("href"),
    ).toBe("https://gamma.app/docs/deck-123");
  });

  it("rejects a non-https deck url", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState(
          {
            template: "completed",
            source: "completed",
            generate: "completed",
            review: "completed",
            render: "completed",
          },
          "completed",
        )}
        connected
        stepOutputs={{
          render: {
            callId: "det-render",
            content: JSON.stringify({
              gammaUrl: "http://insecure.example/deck",
            }),
          },
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    expect(screen.queryByTitle("Generated Gamma presentation")).toBeNull();
    screen.getByText("Presentation URL is invalid or unavailable.");
  });

  it("shows the generation-failed banner when the run phase is failed", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState(
          { template: "completed", source: "completed", generate: "failed" },
          "failed",
        )}
        connected
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Generation failed");
    screen.getByText(
      "The deck could not be generated. Start a new run to try again.",
    );
  });

  it("shows a malformed-output error when generate completes with an unreadable result", () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          template: "completed",
          source: "completed",
          generate: "completed",
        })}
        connected
        stepOutputs={{ generate: { outline: 42 } }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Couldn’t read the draft outline.");
  });
});
