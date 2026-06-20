/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { RunState, StepState } from "@intx/workflow";
import type { WorkflowPanelProps } from "@workbench/ui";

afterEach(cleanup);

// framer-motion (used by HorizontalStepper) is not compatible with Happy DOM.
mock.module("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({
      children,
      className,
    }: {
      children: React.ReactNode;
      className?: string;
    }) => React.createElement("div", { className }, children),
  },
}));

const { Panel } = await import("./ui");

type Phase = StepState["phase"];

function makeState(phases: Partial<Record<string, Phase>>): RunState {
  const steps = new Map<string, StepState>();
  for (const [stepId, phase] of Object.entries(phases)) {
    if (!phase) continue;
    steps.set(stepId, {
      stepId,
      phase,
      currentAttempt: 1,
    } as unknown as StepState);
  }
  return {
    phase: "running",
    steps,
  } as unknown as RunState;
}

function renderPanel(overrides: Partial<WorkflowPanelProps> = {}) {
  const onSignal = mock((_name: string, _payload?: unknown) => {});
  const onClose = mock(() => {});
  const props: WorkflowPanelProps = {
    deploymentId: "dep_1",
    state: makeState({}),
    connected: true,
    stepOutputs: {},
    onSignal,
    onClose,
    ...overrides,
  };
  render(<Panel {...props} />);
  return { onSignal, onClose };
}

describe("ab-compare Panel", () => {
  it("renders the header and every step label", () => {
    renderPanel();
    screen.getByText("A/B Compare");
    for (const label of ["Input", "Execute", "Compare", "Review", "Persist"]) {
      screen.getByText(label);
    }
  });

  it("renders the input form while the input step awaits a signal", () => {
    renderPanel({ state: makeState({ input: "awaiting-signal" }) });
    screen.getByText("Content");
    screen.getByText("Shared prompt");
    screen.getByText("Start comparison");
  });

  it("fires onSignal with the input payload when the form is submitted", () => {
    const { onSignal } = renderPanel({
      state: makeState({ input: "awaiting-signal" }),
    });
    fireEvent.change(
      screen.getByPlaceholderText("The text to compare across providers"),
      {
        target: { value: "Variant source text" },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText("The prompt to run against each provider"),
      {
        target: { value: "Rewrite for clarity" },
      },
    );
    fireEvent.click(screen.getByText("Start comparison"));
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      "input",
      { content: "Variant source text", prompt: "Rewrite for clarity" },
    ]);
  });

  it("does not submit input when content or prompt is empty", () => {
    const { onSignal } = renderPanel({
      state: makeState({ input: "awaiting-signal" }),
    });
    const button = screen.getByText("Start comparison") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it("disables input submission while disconnected", () => {
    const { onSignal } = renderPanel({
      state: makeState({ input: "awaiting-signal" }),
      connected: false,
    });
    fireEvent.change(
      screen.getByPlaceholderText("The text to compare across providers"),
      {
        target: { value: "text" },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText("The prompt to run against each provider"),
      {
        target: { value: "prompt" },
      },
    );
    const button = screen.getByText("Start comparison") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it("renders provider branch outputs from stepOutputs.execute", () => {
    renderPanel({
      state: makeState({ execute: "completed" }),
      stepOutputs: {
        execute: {
          branches: [
            { provider: "OpenAI", model: "gpt-x", output: "Variant A copy" },
            {
              provider: "Anthropic",
              model: "claude-x",
              output: "Variant B copy",
            },
          ],
        },
      },
    });
    screen.getByText("OpenAI");
    screen.getByText("Variant A copy");
    screen.getByText("Anthropic");
    screen.getByText("Variant B copy");
  });

  it("renders the blind ranking from stepOutputs.compare", () => {
    renderPanel({
      state: makeState({ compare: "completed" }),
      stepOutputs: {
        compare: {
          summary: "B reads cleaner.",
          ranking: [
            { rank: 1, label: "Variant B", rationale: "tighter hook" },
            { rank: 2, label: "Variant A", rationale: "wordy" },
          ],
        },
      },
    });
    screen.getByText("B reads cleaner.");
    screen.getByText("Variant B");
    screen.getByText("tighter hook");
    screen.getByText("Variant A");
  });

  it("fires onSignal with approval payload when Approve is clicked", () => {
    const { onSignal } = renderPanel({
      state: makeState({ review: "awaiting-signal" }),
    });
    fireEvent.click(screen.getByText("Approve comparison"));
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      "comparison-review",
      { approved: true },
    ]);
  });

  it("disables Approve while disconnected", () => {
    const { onSignal } = renderPanel({
      state: makeState({ review: "awaiting-signal" }),
      connected: false,
    });
    const button = screen.getByText("Approve comparison") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it("does not show the Approve button before the review step awaits a signal", () => {
    renderPanel({ state: makeState({ compare: "completed" }) });
    expect(screen.queryByText("Approve comparison")).toBeNull();
  });

  it("renders the saved artifact from the deterministic persist tool envelope", () => {
    renderPanel({
      state: makeState({ persist: "completed" }),
      stepOutputs: {
        persist: {
          callId: "det-persist",
          content: JSON.stringify({
            artifactId: "art_1",
            title: "A/B Comparison Results",
            kind: "document",
            version: 1,
          }),
        },
      },
    });
    screen.getByText("A/B Comparison Results");
    screen.getByText("document");
  });

  it("shows a failure message when the run failed", () => {
    renderPanel({
      state: { phase: "failed", steps: new Map() } as unknown as RunState,
    });
    screen.getByText(/This run failed/);
  });

  it("shows a malformed-output error when a completed step output fails validation", () => {
    renderPanel({
      state: makeState({ execute: "completed" }),
      stepOutputs: { execute: { branches: "not-an-array" } },
    });
    screen.getByText("Couldn’t read the provider outputs for this step.");
  });

  it("fires onClose when Close is clicked", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByLabelText("Close panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
