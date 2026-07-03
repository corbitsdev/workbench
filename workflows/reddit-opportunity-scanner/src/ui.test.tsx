/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { RunState, StepPhase, StepState } from "@intx/workflow";
import type { WorkflowPanelProps } from "@workbench/ui";

afterEach(cleanup);

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
    logRead: true,
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
  icp: "Platform and SRE teams",
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
  searches: [
    {
      subreddit: "devops",
      query: "observability pricing",
      intent: "buying-intent",
      reason: "Find teams asking about tooling cost.",
    },
  ],
});
const ANALYZE_STEP_OUTPUT = { reply: ANALYZE_REPLY };

const CURATE_OUTPUT_REPLY = JSON.stringify({
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
const CURATE_STEP_OUTPUT = { reply: CURATE_OUTPUT_REPLY };

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
    screen.getAllByText("Website");
    screen.getByText("Strategy");
    screen.getByText("Search plan");
    screen.getByText("Collect");
    screen.getByText("Opportunities");
    screen.getByText("Done");
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
    screen.getByText("Couldn't crawl the site.");
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
      searches: unknown[];
    };
    expect(payload.keywords).toEqual(["observability", "distributed tracing"]);
    expect(payload.subreddits).toEqual(["devops", "sre"]);
    expect(payload.competitors).toEqual(["Datadog"]);
    expect(payload.businessContext).toContain("Observability tooling");
    expect(payload.searches).toHaveLength(1);
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

  it("submits only the edited search rows — removing a row drops its search", () => {
    const twoSearchReply = JSON.stringify({
      whatTheySell: "Observability tooling",
      keywords: [{ label: "observability" }],
      subreddits: [{ label: "devops" }, { label: "sre" }],
      searches: [
        { subreddit: "devops", query: "observability pricing" },
        { subreddit: "sre", query: "apm alternatives" },
      ],
    });
    const { onSignal } = renderPanel({
      state: makeState({
        intake: "completed",
        scrape: "completed",
        analyze: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { analyze: { reply: twoSearchReply } },
    });

    screen.getByText("2 searches");
    fireEvent.click(screen.getByLabelText("Remove search 2"));
    screen.getByText("1 search");
    fireEvent.click(screen.getByText("Scan Reddit"));

    const payload = onSignal.mock.calls[0]?.[1] as {
      searches: { subreddit: string; query: string }[];
    };
    expect(payload.searches).toHaveLength(1);
    expect(payload.searches[0]?.subreddit).toBe("devops");
    expect(payload.searches[0]?.query).toBe("observability pricing");
  });

  it("submits an edited subreddit/query rather than the inferred value", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        intake: "completed",
        scrape: "completed",
        analyze: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { analyze: ANALYZE_STEP_OUTPUT },
    });

    fireEvent.change(screen.getByLabelText("Subreddit for search 1"), {
      target: { value: "kubernetes" },
    });
    fireEvent.change(screen.getByLabelText("Query for search 1"), {
      target: { value: "tracing cost" },
    });
    fireEvent.click(screen.getByText("Scan Reddit"));

    const payload = onSignal.mock.calls[0]?.[1] as {
      searches: { subreddit: string; query: string }[];
    };
    expect(payload.searches).toHaveLength(1);
    expect(payload.searches[0]?.subreddit).toBe("kubernetes");
    expect(payload.searches[0]?.query).toBe("tracing cost");
  });

  it("disables Scan Reddit once the only search row is removed", () => {
    renderPanel({
      state: makeState({
        intake: "completed",
        scrape: "completed",
        analyze: "completed",
        review: "awaiting-signal",
      }),
      stepOutputs: { analyze: ANALYZE_STEP_OUTPUT },
    });

    fireEvent.click(screen.getByLabelText("Remove search 1"));
    screen.getByText("No searches yet. Add one to scan Reddit.");
    expect(
      (screen.getByText("Scan Reddit") as HTMLButtonElement).disabled,
    ).toBe(true);
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

  // ── Collect + curate screens ─────────────────────────────────────────────────

  it("shows a loading state while collect is in-flight", () => {
    renderPanel({
      state: makeState({ ...REVIEW_DONE, collect: "in-flight" }),
      stepOutputs: {},
    });
    screen.getByText("Collecting Reddit evidence");
  });

  it("shows a loading state while curate is in-flight", () => {
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "in-flight",
      }),
      stepOutputs: {},
    });
    screen.getByText("Ranking opportunities");
  });

  it("renders ranked opportunities when curate completes and selection is gated", () => {
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: { curate: CURATE_STEP_OUTPUT },
    });
    screen.getByText("Anyone using X for tracing?");
    screen.getByText("Frustrated with current APM tools");
  });

  it("renders opportunities from outputs decoded off the run-keyed /state inline refs (CL-2704)", () => {
    // Under per-run deployments the host derives stepOutputs by JSON-parsing the
    // log fold's `inline:` outputRefs — pin that this round-trip yields exactly
    // the map shape the panel decodes.
    const curateRef = `inline:${JSON.stringify(CURATE_STEP_OUTPUT)}`;
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: {
        curate: JSON.parse(curateRef.slice("inline:".length)) as unknown,
      },
    });
    screen.getByText("Anyone using X for tracing?");
    screen.getByText("Frustrated with current APM tools");
  });

  // ── Selection screen ──────────────────────────────────────────────────────────

  it("fires opportunity-selection with selected opportunity objects", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: { curate: CURATE_STEP_OUTPUT },
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
        collect: "completed",
        curate: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: { curate: CURATE_STEP_OUTPUT },
    });
    const saveButton = screen.getByText("Save opportunities");
    expect(saveButton.closest("button")?.disabled).toBe(true);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("can select then deselect an opportunity", () => {
    const { onSignal } = renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: { curate: CURATE_STEP_OUTPUT },
    });

    const firstCard = screen.getByText("Anyone using X for tracing?");
    fireEvent.click(firstCard);
    fireEvent.click(firstCard);
    fireEvent.click(screen.getByText("Frustrated with current APM tools"));
    fireEvent.click(screen.getByText("Save 1 opportunity"));

    const payload = onSignal.mock.calls[0]?.[1] as { selected: unknown[] };
    expect((payload.selected[0] as { id: string }).id).toBe("opp-2");
  });

  it("shows a no-results message when curate produced no opportunities", () => {
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "completed",
        selection: "awaiting-signal",
      }),
      stepOutputs: { curate: { reply: JSON.stringify({ opportunities: [] }) } },
    });
    screen.getByText("No opportunities to review.");
  });

  // ── Persist screen ────────────────────────────────────────────────────────────

  it("shows a loading state while persist is in-flight", () => {
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "completed",
        selection: "completed",
        persist: "in-flight",
      }),
      stepOutputs: {},
    });
    screen.getByText("Saving documents");
  });

  it("renders saved artifacts from persist output when run completes", () => {
    const persistOutput = [
      {
        callId: "c1",
        content: JSON.stringify({
          artifactId: "art-1",
          title: "Opp 1",
          kind: "reddit-opportunity-scan",
        }),
      },
    ];
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "completed",
        selection: "completed",
        persist: "completed",
      }),
      stepOutputs: { persist: persistOutput },
    });
    screen.getByText("Done — 1 document saved");
    screen.getByText("Opp 1");
  });

  it("frames a zero-saved persist result as a failure, not a success", () => {
    const { onClose } = renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "completed",
        selection: "completed",
        persist: "completed",
      }),
      stepOutputs: { persist: [{ callId: "c1", content: "not json{{" }] },
    });
    screen.getByText("Couldn't save your opportunities");
    expect(screen.queryByText(/Done —/)).toBeNull();
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("reports a partial save as 'Saved N of M documents'", () => {
    const persistOutput = [
      {
        callId: "c1",
        content: JSON.stringify({ artifactId: "art-1", title: "Opp 1" }),
      },
      { callId: "c2", content: "not json{{" },
    ];
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "completed",
        selection: "completed",
        persist: "completed",
      }),
      stepOutputs: { persist: persistOutput },
    });
    screen.getByText("Saved 1 of 2 documents");
    screen.getByText("Opp 1");
    expect(screen.queryByText(/Done —/)).toBeNull();
  });

  // ── Failure ───────────────────────────────────────────────────────────────────

  it("shows a failure banner with the sanitized step error when a step fails (CL-2660)", () => {
    const steps = new Map<string, StepState>();
    steps.set("intake", stepState("intake", "completed"));
    steps.set("curate", {
      stepId: "curate",
      phase: "failed",
      currentAttempt: 1,
      lastError: { message: "ScrapeCreators API error: 429 rate limited" },
    } as StepState);
    renderPanel({ state: { steps, phase: "failed" } as unknown as RunState });
    screen.getByText("This run failed.");
    screen.getByText(/ScrapeCreators is rate-limiting requests right now/);
    expect(screen.queryByText(/API error/)).toBeNull();
  });

  // ── Guided layout — only the active step rendered ──────────────────────────────

  it("does not render the intake form while scrape is active", () => {
    renderPanel({
      state: makeState({ intake: "completed", scrape: "in-flight" }),
    });
    expect(screen.queryByLabelText(/Website URL/)).toBeNull();
  });

  it("does not render the selection action while curate is in-flight", () => {
    renderPanel({
      state: makeState({
        ...REVIEW_DONE,
        collect: "completed",
        curate: "in-flight",
      }),
    });
    expect(screen.queryByText("Save opportunities")).toBeNull();
    expect(screen.queryByText(/Save \d+ opportunit/)).toBeNull();
  });

  it("does not render the persist 'Saving' screen for a null/initial state", () => {
    renderPanel({ state: null });
    expect(screen.queryByText("Saving documents")).toBeNull();
    expect(screen.queryByText(/Done —/)).toBeNull();
  });

  it("does not rewind to intake when the intake gate's output is absent but scrape is running (CL-2506)", () => {
    // The intake awaitSignal gate's StepCompleted is missing from the
    // synthesized state, but scrape is in-flight: the panel must stay on
    // Scrape, not fall back to the intake gate screen.
    renderPanel({ state: makeState({ scrape: "in-flight" }) });
    screen.getByText("Crawling the site");
    expect(screen.queryByLabelText(/Website URL/)).toBeNull();
    expect(screen.queryByText("What should we analyze?")).toBeNull();
  });
});
