/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { RunState, StepPhase, StepState } from "@intx/workflow";
import type { WorkflowPanelProps } from "@workbench/ui";

afterEach(cleanup);

// Stub framer-motion before importing the module under test
const passthroughMotion = ({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) => React.createElement("div", { className }, children);

mock.module("framer-motion", () => ({
  motion: new Proxy({}, { get: () => passthroughMotion }),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

const { Panel } = await import("./ui");

// ── Helpers ───────────────────────────────────────────────────────────────────

function stepState(stepId: string, phase: StepPhase): StepState {
  return { stepId, phase, currentAttempt: 1 } as StepState;
}

function makeState(phases: Record<string, StepPhase>): RunState {
  const steps = new Map<string, StepState>();
  for (const [id, phase] of Object.entries(phases)) {
    steps.set(id, stepState(id, phase));
  }
  return { steps } as unknown as RunState;
}

function renderPanel(overrides: Partial<WorkflowPanelProps> = {}) {
  const onSignal = mock((_name: string, _payload?: unknown) => {});
  const onClose = mock(() => {});
  const props: WorkflowPanelProps = {
    deploymentId: "dep-1",
    state: null,
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

const ANALYZE_REPLY = JSON.stringify({
  whatTheySell: "Observability tooling for platform teams",
  mainKeywords: ["observability"],
  competitors: ["Datadog"],
  audienceNotes: "Platform and SRE teams",
  evidence: ["from the homepage"],
  keywords: [
    { label: "observability", reason: "category", confidence: 0.9 },
    { label: "distributed tracing", reason: "feature", confidence: 0.8 },
  ],
  subreddits: [
    { label: "devops", reason: "audience", confidence: 0.9 },
    { label: "sre", reason: "audience", confidence: 0.8 },
  ],
});
const ANALYZE_STEP_OUTPUT = { reply: ANALYZE_REPLY };

const SCAN_OUTPUT_REPLY = JSON.stringify({
  opportunities: [
    {
      id: "opp-1",
      title: "Anyone using X for tracing?",
      subreddit: "devops",
      signal: "buying-signal",
      detail: "Active buying-intent thread.",
      url: "https://reddit.com/r/devops/x",
    },
    {
      id: "opp-2",
      title: "Frustrated with current APM tools",
      subreddit: "sre",
      signal: "pain-point",
      detail: "Users complaining about cost.",
    },
  ],
});
const SCAN_STEP_OUTPUT = { reply: SCAN_OUTPUT_REPLY };

const REVIEW_DONE = {
  intake: "completed",
  scrape: "completed",
  analyze: "completed",
  review: "completed",
} as const;

describe("reddit-opportunity-scanner Panel", () => {
  // ── Stepper ──────────────────────────────────────────────────────────────

  it("shows every restored step label in the stepper", () => {
    renderPanel({ state: makeState({ intake: "awaiting-signal" }) });
    screen.getByText("Intake");
    screen.getByText("Scrape");
    screen.getByText("Analyze");
    screen.getByText("Review");
    screen.getByText("Scan");
    screen.getByText("Select");
    screen.getByText("Persist");
  });

  it("marks completed steps with a checkmark and the active step as current", () => {
    renderPanel({
      state: makeState({ intake: "completed", scrape: "in-flight" }),
    });
    expect(screen.getAllByText("✓").length).toBeGreaterThanOrEqual(1);
    // scrape is step number 2 and current
    screen.getByText("2");
  });

  // ── Intake screen (URL + hints) ────────────────────────────────────────────

  it("renders the URL intake form while intake is awaiting-signal", () => {
    renderPanel({ state: makeState({ intake: "awaiting-signal" }) });
    screen.getByLabelText(/Website URL/);
    screen.getByText("Analyze site");
  });

  it("fires intake signal with the URL and trimmed optional hints", () => {
    const { onSignal } = renderPanel({
      state: makeState({ intake: "awaiting-signal" }),
    });

    fireEvent.change(screen.getByLabelText(/Website URL/), {
      target: { value: "https://example.com" },
    });
    fireEvent.change(screen.getByLabelText(/Brand name/), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Analyze site"));

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      "intake",
      { inputUrl: "https://example.com", brandName: "Acme" },
    ]);
  });

  it("disables the intake submit until a valid http(s) URL is entered", () => {
    const { onSignal } = renderPanel({
      state: makeState({ intake: "awaiting-signal" }),
    });
    const button = screen.getByText("Analyze site") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Website URL/), {
      target: { value: "not-a-url" },
    });
    expect(
      (screen.getByText("Analyze site") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByText("Analyze site"));
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("does not submit intake while a signal is pending", () => {
    const { onSignal } = renderPanel({
      state: makeState({ intake: "awaiting-signal" }),
      signalPending: true,
    });
    fireEvent.change(screen.getByLabelText(/Website URL/), {
      target: { value: "https://example.com" },
    });
    const button = screen.getByText("Analyze site") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).not.toHaveBeenCalled();
  });

  // ── Scrape screen ──────────────────────────────────────────────────────────

  it("shows a crawling state while scrape is in-flight", () => {
    renderPanel({
      state: makeState({ intake: "completed", scrape: "in-flight" }),
    });
    screen.getByText("Crawling the site");
  });

  it("shows a scrape failure message when scrape fails", () => {
    renderPanel({
      state: makeState({ intake: "completed", scrape: "failed" }),
    });
    screen.getByText("Couldn't scrape the site.");
  });

  // ── Analyze + Review screen ──────────────────────────────────────────────────

  it("shows an analyzing spinner while review is gated and analyze output is absent", () => {
    renderPanel({
      state: makeState({
        intake: "completed",
        scrape: "completed",
        analyze: "in-flight",
      }),
      stepOutputs: {},
    });
    screen.getByText("Analyzing the site");
  });

  it("renders inferred keywords and subreddits as editable chips on the review screen", () => {
    renderPanel({
      state: makeState({
        intake: "completed",
        scrape: "completed",
        analyze: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { analyze: ANALYZE_STEP_OUTPUT },
    });
    screen.getByText("Review keywords and subreddits");
    screen.getByText("observability");
    screen.getByText("distributed tracing");
    screen.getByText("devops");
    screen.getByText("sre");
  });

  it("fires recommendation-review with the approved keywords, subreddits, and competitors", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        intake: "completed",
        scrape: "completed",
        analyze: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { analyze: ANALYZE_STEP_OUTPUT },
    });

    fireEvent.click(screen.getByText("Scan Reddit"));

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]?.[0]).toBe("recommendation-review");
    const payload = onSignal.mock.calls[0]?.[1] as {
      keywords: string[];
      subreddits: string[];
      competitors: string[];
      businessContext: string;
    };
    expect(payload.keywords).toEqual(["observability", "distributed tracing"]);
    expect(payload.subreddits).toEqual(["devops", "sre"]);
    expect(payload.competitors).toEqual(["Datadog"]);
    expect(payload.businessContext).toContain("Observability tooling");
  });

  it("lets the operator remove an inferred keyword before scanning", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        intake: "completed",
        scrape: "completed",
        analyze: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { analyze: ANALYZE_STEP_OUTPUT },
    });

    fireEvent.click(screen.getByLabelText("Remove distributed tracing"));
    fireEvent.click(screen.getByText("Scan Reddit"));

    const payload = onSignal.mock.calls[0]?.[1] as { keywords: string[] };
    expect(payload.keywords).toEqual(["observability"]);
  });

  it("shows a malformed-analysis error when analyze output fails validation", () => {
    renderPanel({
      state: makeState({
        intake: "completed",
        scrape: "completed",
        analyze: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { analyze: { reply: "not json{{" } },
    });
    screen.getByText("Couldn't read the analysis.");
  });

  // ── Scan screen ──────────────────────────────────────────────────────────────

  it("shows a loading state while scan is in-flight", () => {
    renderPanel({
      state: makeState({ ...REVIEW_DONE, scan: "in-flight" }),
      stepOutputs: {},
    });
    screen.getByText("Scanning Reddit");
  });

  it("renders ranked opportunities when scan completes and selection is gated", () => {
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        scan: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: { scan: SCAN_STEP_OUTPUT },
    });
    screen.getByText("Anyone using X for tracing?");
    screen.getByText("Frustrated with current APM tools");
  });

  // ── Selection screen ──────────────────────────────────────────────────────────

  it("fires opportunity-selection with selected opportunity objects", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        scan: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: { scan: SCAN_STEP_OUTPUT },
    });

    fireEvent.click(screen.getByText("Anyone using X for tracing?"));
    fireEvent.click(screen.getByText("Save 1 opportunity"));

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]?.[0]).toBe("opportunity-selection");
    const payload = onSignal.mock.calls[0]?.[1] as { selected: unknown[] };
    expect(payload.selected).toHaveLength(1);
    expect((payload.selected[0] as { id: string }).id).toBe("opp-1");
  });

  it("does not fire selection when no opportunities are selected", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        scan: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: { scan: SCAN_STEP_OUTPUT },
    });
    const saveButton = screen.getByText("Save opportunities");
    expect(saveButton.closest("button")?.disabled).toBe(true);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("can select then deselect an opportunity", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        scan: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: { scan: SCAN_STEP_OUTPUT },
    });

    const firstCard = screen.getByText("Anyone using X for tracing?");
    fireEvent.click(firstCard);
    fireEvent.click(firstCard);
    fireEvent.click(screen.getByText("Frustrated with current APM tools"));
    fireEvent.click(screen.getByText("Save 1 opportunity"));

    const payload = onSignal.mock.calls[0]?.[1] as { selected: unknown[] };
    expect((payload.selected[0] as { id: string }).id).toBe("opp-2");
  });

  it("shows a no-results message when scan produced no opportunities", () => {
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        scan: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: { scan: { reply: JSON.stringify({ opportunities: [] }) } },
    });
    screen.getByText("No opportunities to review.");
  });

  // ── Persist screen ────────────────────────────────────────────────────────────

  it("shows a loading state while persist is in-flight", () => {
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        scan: "completed",
        selection: "completed",
        persist: "in-flight",
      }),
      stepOutputs: {},
    });
    screen.getByText("Saving artifacts");
  });

  it("renders saved artifacts from persist output when run completes", () => {
    const persistOutput = [
      {
        callId: "c1",
        content: JSON.stringify({
          artifactId: "art-1",
          title: "Opp 1",
          kind: "document",
        }),
      },
    ];
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        scan: "completed",
        selection: "completed",
        persist: "completed",
      }),
      stepOutputs: { persist: persistOutput },
    });
    screen.getByText("Done — 1 artifact saved");
    screen.getByText("Opp 1");
  });

  it("shows a Close button on the persist screen and calls onClose", () => {
    const { onClose } = renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        scan: "completed",
        selection: "completed",
        persist: "completed",
      }),
      stepOutputs: { persist: [] },
    });
    screen.getByText("Done — 0 artifacts saved");
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  // ── Failure ───────────────────────────────────────────────────────────────────

  it("shows a failure banner with the step error when a step fails", () => {
    const steps = new Map<string, StepState>();
    steps.set("intake", stepState("intake", "completed"));
    steps.set("scan", {
      stepId: "scan",
      phase: "failed",
      currentAttempt: 1,
      lastError: { message: "Reddit API rate limited" },
    } as StepState);
    renderPanel({ state: { steps, phase: "failed" } as unknown as RunState });
    screen.getByText("This run failed.");
    screen.getByText("Reddit API rate limited");
  });

  // ── Guided layout — only the active step rendered ──────────────────────────────

  it("does not render the intake form while scrape is active", () => {
    renderPanel({
      state: makeState({ intake: "completed", scrape: "in-flight" }),
    });
    expect(screen.queryByLabelText(/Website URL/)).toBeNull();
  });

  it("does not render the selection action while scan is in-flight", () => {
    renderPanel({ state: makeState({ ...REVIEW_DONE, scan: "in-flight" }) });
    expect(screen.queryByText("Save opportunities")).toBeNull();
    expect(screen.queryByText(/Save \d+ opportunit/)).toBeNull();
  });
});
