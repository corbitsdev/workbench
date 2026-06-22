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

function makeState(
  phases: Partial<Record<string, Phase>>,
  runPhase: RunState["phase"] = "running",
): RunState {
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
    phase: runPhase,
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
    signalPending: false,
    onSignal,
    onClose,
    ...overrides,
  };
  render(<Panel {...props} />);
  return { onSignal, onClose };
}

// Fill both variant editors with provider+model and the shared input so the
// config form is submittable. Variant editors share field labels, so target
// the inputs positionally.
function fillConfigForm(opts: { input?: string } = {}) {
  const providers = screen.getAllByPlaceholderText("anthropic");
  const models = screen.getAllByPlaceholderText("claude-sonnet-4");
  fireEvent.change(providers[0]!, { target: { value: "anthropic" } });
  fireEvent.change(models[0]!, { target: { value: "claude-sonnet-4" } });
  fireEvent.change(providers[1]!, { target: { value: "openai" } });
  fireEvent.change(models[1]!, { target: { value: "gpt-4o" } });
  fireEvent.change(
    screen.getByPlaceholderText("The task to run against each variant"),
    {
      target: { value: opts.input ?? "Rewrite for clarity" },
    },
  );
}

// ── Header and stepper ────────────────────────────────────────────────────────

describe("ab-compare Panel — header", () => {
  it("renders the panel header and all step labels in the stepper", () => {
    renderPanel();
    screen.getByText("A/B Compare");
    for (const label of [
      "Configure",
      "Execute",
      "Compare",
      "Review",
      "Persist",
    ]) {
      screen.getByText(label);
    }
  });

  it("renders a close button", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByLabelText("Close panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── Guided step routing ───────────────────────────────────────────────────────

describe("ab-compare Panel — guided routing (ONLY active step shown)", () => {
  it("shows the config screen when config is awaiting-signal", () => {
    renderPanel({ state: makeState({ config: "awaiting-signal" }) });
    screen.getByText("Configure the blind comparison");
    expect(
      screen.queryByText("Running the prompt across variants…"),
    ).toBeNull();
  });

  it("shows the execute screen while execute is in-flight", () => {
    renderPanel({
      state: makeState({ config: "completed", execute: "in-flight" }),
    });
    screen.getByText("Running the prompt across variants…");
    expect(screen.queryByText("Configure the blind comparison")).toBeNull();
  });

  it("shows the compare screen while compare is in-flight", () => {
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "in-flight",
      }),
    });
    screen.getByText("Generating blind ranking…");
  });

  it("shows the review screen when review is awaiting-signal", () => {
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: {
        compare: { reply: "VariantAlpha ranked first", turn: null },
      },
    });
    screen.getByText("Approve comparison");
    screen.getByText("VariantAlpha ranked first");
  });

  it("shows the persist screen when persist is in-flight", () => {
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "completed",
        persist: "in-flight",
      }),
    });
    screen.getByText("Saving artifact…");
  });

  it("shows the persist screen (final) when all steps are completed", () => {
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "completed",
        persist: "completed",
      }),
      stepOutputs: {
        persist: {
          callId: "det-1",
          content: JSON.stringify({
            artifactId: "art_1",
            title: "A/B Comparison Results",
            kind: "document",
            version: 1,
          }),
        },
      },
    });
    screen.getByText("Comparison saved");
    screen.getByText("A/B Comparison Results");
  });
});

// ── Config screen ──────────────────────────────────────────────────────────────

describe("ab-compare Panel — config screen", () => {
  it("shows two variant editors and a shared input", () => {
    renderPanel({ state: makeState({ config: "awaiting-signal" }) });
    screen.getByText("Variant A");
    screen.getByText("Variant B");
    screen.getByPlaceholderText("The task to run against each variant");
    screen.getByText("Run comparison");
  });

  it("run button is disabled until both variants and input are filled", () => {
    renderPanel({ state: makeState({ config: "awaiting-signal" }) });
    const button = screen.getByText("Run comparison") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("fires onSignal with variants and shared input on submit", () => {
    const { onSignal } = renderPanel({
      state: makeState({ config: "awaiting-signal" }),
    });
    fillConfigForm({ input: "Rewrite for clarity" });
    fireEvent.click(screen.getByText("Run comparison"));
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      "ab-config",
      {
        variants: [
          {
            label: "Variant 1",
            providerName: "anthropic",
            model: "claude-sonnet-4",
            input: "Rewrite for clarity",
          },
          {
            label: "Variant 2",
            providerName: "openai",
            model: "gpt-4o",
            input: "Rewrite for clarity",
          },
        ],
        input: "Rewrite for clarity",
      },
    ]);
  });

  it("includes optional skill and instruction on a variant when provided", () => {
    const { onSignal } = renderPanel({
      state: makeState({ config: "awaiting-signal" }),
    });
    fillConfigForm();
    const skills = screen.getAllByPlaceholderText("e.g. Hammy humanizer");
    fireEvent.change(skills[0]!, { target: { value: "Hammy" } });
    const instructions = screen.getAllByPlaceholderText(
      "A variant-specific system prompt",
    );
    fireEvent.change(instructions[0]!, { target: { value: "Be terse" } });
    fireEvent.click(screen.getByText("Run comparison"));
    const payload = onSignal.mock.calls[0]![1] as {
      variants: { skill?: string; systemPrompt?: string }[];
    };
    expect(payload.variants[0]!.skill).toBe("Hammy");
    expect(payload.variants[0]!.systemPrompt).toBe("Be terse");
    expect(payload.variants[1]!.skill).toBeUndefined();
  });

  it("trims whitespace from the shared input before submitting", () => {
    const { onSignal } = renderPanel({
      state: makeState({ config: "awaiting-signal" }),
    });
    fillConfigForm({ input: "  hello  " });
    fireEvent.click(screen.getByText("Run comparison"));
    const payload = onSignal.mock.calls[0]![1] as { input: string };
    expect(payload.input).toBe("hello");
  });

  it("disables submission while disconnected", () => {
    const { onSignal } = renderPanel({
      state: makeState({ config: "awaiting-signal" }),
      connected: false,
    });
    fillConfigForm();
    const button = screen.getByText("Run comparison") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it("disables submission while a signal is pending", () => {
    const { onSignal } = renderPanel({
      state: makeState({ config: "awaiting-signal" }),
      signalPending: true,
    });
    fillConfigForm();
    const button = screen.getByText("Run comparison") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });
});

// ── Execute screen ────────────────────────────────────────────────────────────

describe("ab-compare Panel — execute screen", () => {
  it("shows a loading state while execute is in-flight", () => {
    renderPanel({
      state: makeState({ config: "completed", execute: "in-flight" }),
    });
    screen.getByText("Running the prompt across variants…");
    expect(screen.queryByText("Configure the blind comparison")).toBeNull();
  });

  it("renders one anonymous output per variant from the map output array on the review screen", () => {
    // The map output (an array of per-variant agent outputs) surfaces on the
    // review screen, where the human inspects each blind output before ranking.
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: {
        execute: [{ reply: "Answer one" }, { reply: "Answer two" }],
        compare: { reply: "ranked", turn: null },
      },
    });
    screen.getByText("Answer one");
    screen.getByText("Answer two");
    // Outputs are labeled by position, never by provider/model.
    expect(screen.queryByText("anthropic")).toBeNull();
  });
});

// ── Compare output rendered via review screen ─────────────────────────────────

describe("ab-compare Panel — compare output (via review screen)", () => {
  it("renders structured ranking when the compare agent emits strict JSON", () => {
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: {
        compare: {
          reply: JSON.stringify({
            summary: "B reads cleaner.",
            ranking: [
              { rank: 1, label: "Variant B", rationale: "tighter hook" },
              { rank: 2, label: "Variant A", rationale: "wordy" },
            ],
            recommendation: "Keep the Variant B hook.",
          }),
          turn: null,
        },
      },
    });
    screen.getByText("B reads cleaner.");
    screen.getByText("Variant B");
    screen.getByText("tighter hook");
    screen.getByText("Variant A");
    screen.getByText("wordy");
    screen.getByText("Keep the Variant B hook.");
  });

  it("falls back to plain-text reply when the compare agent does not emit strict JSON", () => {
    const reply = "VariantB best. VariantA verbose.";
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { compare: { reply, turn: null } },
    });
    screen.getByText(reply);
  });

  it("renders the plain-text fallback reply as parsed markdown", () => {
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { compare: { reply: "Variant **B** wins", turn: null } },
    });
    const strong = screen.getByText("B");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.queryByText("Variant **B** wins")).toBeNull();
  });

  it("shows an error when compare output fails validation", () => {
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { compare: { notReply: true } },
    });
    screen.getByText("Couldn't read the comparison output.");
  });
});

// ── Review screen ─────────────────────────────────────────────────────────────

describe("ab-compare Panel — review screen", () => {
  it("fires onSignal with { approved: true } when Approve is clicked", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { compare: { reply: "ranked", turn: null } },
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
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "awaiting-signal",
      }),
      connected: false,
      stepOutputs: { compare: { reply: "ranked", turn: null } },
    });
    const button = screen.getByText("Approve comparison") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it("disables Approve while a signal is pending", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "awaiting-signal",
      }),
      signalPending: true,
      stepOutputs: { compare: { reply: "ranked", turn: null } },
    });
    const button = screen.getByText("Approve comparison") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it("does not show the review screen before compare completes", () => {
    renderPanel({
      state: makeState({ config: "completed", execute: "completed" }),
    });
    expect(screen.queryByText("Approve comparison")).toBeNull();
  });
});

// ── Persist screen ────────────────────────────────────────────────────────────

describe("ab-compare Panel — persist screen", () => {
  it("renders the saved artifact from the deterministic tool envelope", () => {
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "completed",
        persist: "completed",
      }),
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

  it("shows a fallback message when artifact envelope is missing", () => {
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        compare: "completed",
        review: "completed",
        persist: "completed",
      }),
      stepOutputs: { persist: { notCallId: true } },
    });
    screen.getByText("Couldn't read the saved artifact.");
  });
});

// ── Failure state ─────────────────────────────────────────────────────────────

describe("ab-compare Panel — failure state", () => {
  it("shows a failure message when the run failed", () => {
    renderPanel({
      state: { phase: "failed", steps: new Map() } as unknown as RunState,
    });
    screen.getByText(/This run failed/);
  });
});
