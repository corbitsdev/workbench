/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { RunState, StepState } from "@intx/workflow";
import type {
  WorkflowCredential,
  WorkflowPanelProps,
  WorkflowSkill,
} from "@workbench/ui";

afterEach(cleanup);

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
  return { phase: runPhase, steps } as unknown as RunState;
}

const MOCK_CREDENTIALS: WorkflowCredential[] = [
  {
    id: "cred_anthropic",
    name: "Anthropic",
    providerName: "anthropic",
    providerPlugin: "anthropic",
  },
  {
    id: "cred_openai",
    name: "OpenAI",
    providerName: "openai",
    providerPlugin: "openai",
  },
];

const MOCK_SKILLS: WorkflowSkill[] = [];

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
    credentials: MOCK_CREDENTIALS,
    skills: MOCK_SKILLS,
    ...overrides,
  };
  render(<Panel {...props} />);
  return { onSignal, onClose };
}

// Step outputs that put the run on the decision screen with two blind variants.
const DECISION_OUTPUTS = {
  config: {
    variants: [
      {
        label: "Variant 1",
        providerName: "anthropic",
        model: "claude",
        input: "x",
      },
      {
        label: "Variant 2",
        providerName: "openai",
        model: "gpt",
        input: "x",
      },
    ],
    input: "x",
  },
  execute: [{ reply: "Answer one" }, { reply: "Answer two" }],
};

const DECISION_STATE = makeState({
  config: "completed",
  execute: "completed",
  decision: "awaiting-signal",
});

describe("ab-compare-hitl Panel — header & stepper", () => {
  it("renders the HITL header and the four step labels", () => {
    renderPanel();
    screen.getByText("A/B Test - Human Select");
    for (const label of ["Configure", "Execute", "Decide", "Persist"]) {
      screen.getByText(label);
    }
  });
});

describe("ab-compare-hitl Panel — guided routing", () => {
  it("does not rewind to config when the config gate's output is absent but execute is running (CL-2506)", () => {
    // config (an awaitSignal gate) is missing from the synthesized state, but
    // execute is in-flight: the panel must stay on Execute, not fall back to the
    // config wizard.
    renderPanel({ state: makeState({ execute: "in-flight" }) });
    screen.getByText("Running the prompt across variants…");
    expect(
      screen.queryByPlaceholderText(
        "Paste the prompt you want to run across all providers…",
      ),
    ).toBeNull();
  });
});

describe("ab-compare-hitl Panel — decision screen", () => {
  it("shows the blind variant outputs and the winner picker", () => {
    renderPanel({ state: DECISION_STATE, stepOutputs: DECISION_OUTPUTS });
    screen.getByText("Pick the winner");
    screen.getByText("Answer one");
    screen.getByText("Answer two");
    // Blind: provider/model identity is hidden until a winner is picked.
    expect(screen.queryByText("anthropic · claude")).toBeNull();
  });

  it("fires ab-decision with the picked winner ranked first", () => {
    const { onSignal } = renderPanel({
      state: DECISION_STATE,
      stepOutputs: DECISION_OUTPUTS,
    });
    fireEvent.click(screen.getByRole("radio", { name: "Variant 2" }));
    fireEvent.click(screen.getByText("Save decision"));
    expect(onSignal).toHaveBeenCalledTimes(1);
    const [name, payload] = onSignal.mock.calls[0]! as [
      string,
      { ranking: { rank: number; label: string }[] },
    ];
    expect(name).toBe("ab-decision");
    expect(payload.ranking).toEqual([
      { rank: 1, label: "Variant 2" },
      { rank: 2, label: "Variant 1" },
    ]);
  });

  it("includes the reviewer's rationale on the winning entry", () => {
    const { onSignal } = renderPanel({
      state: DECISION_STATE,
      stepOutputs: DECISION_OUTPUTS,
    });
    fireEvent.click(screen.getByRole("radio", { name: "Variant 1" }));
    fireEvent.change(
      screen.getByPlaceholderText("What made the winning variant better…"),
      { target: { value: "tighter hook" } },
    );
    fireEvent.click(screen.getByText("Save decision"));
    const payload = onSignal.mock.calls[0]![1] as {
      ranking: { rank: number; label: string; rationale?: string }[];
    };
    expect(payload.ranking[0]).toEqual({
      rank: 1,
      label: "Variant 1",
      rationale: "tighter hook",
    });
  });

  it("requires a winner before saving", () => {
    const { onSignal } = renderPanel({
      state: DECISION_STATE,
      stepOutputs: DECISION_OUTPUTS,
    });
    fireEvent.click(screen.getByText("Save decision"));
    screen.getByText("Pick a winning variant.");
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it("disables the picker while disconnected", () => {
    renderPanel({
      state: DECISION_STATE,
      stepOutputs: DECISION_OUTPUTS,
      connected: false,
    });
    const save = screen.getByText("Save decision") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});

describe("ab-compare-hitl Panel — persist screen", () => {
  it("reveals provider/model identity in the saved comparison", () => {
    renderPanel({
      state: makeState({
        config: "completed",
        execute: "completed",
        decision: "completed",
        compose: "completed",
        persist: "completed",
      }),
      stepOutputs: {
        ...DECISION_OUTPUTS,
        decision: {
          ranking: [
            { rank: 1, label: "Variant 1", rationale: "clearer" },
            { rank: 2, label: "Variant 2" },
          ],
        },
        persist: {
          callId: "det-1",
          content: JSON.stringify({ artifactId: "art_1", title: "Results" }),
        },
      },
    });
    screen.getByText("anthropic · claude");
    screen.getByText("openai · gpt");
  });
});

describe("ab-compare-hitl Panel — failure state", () => {
  it("shows a failure message when the run failed", () => {
    renderPanel({
      state: { phase: "failed", steps: new Map() } as unknown as RunState,
    });
    screen.getByText(/This run failed/);
  });
});
