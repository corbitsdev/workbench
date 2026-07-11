import { describe, expect, it, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RunState } from "@intx/workflow";
import { Panel } from "./ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function toolResult(value: unknown): { callId: string; content: string } {
  return { callId: "c1", content: JSON.stringify(value) };
}

function agentReply(value: unknown): { reply: string } {
  return { reply: JSON.stringify(value) };
}

const NOTE_LIST = toolResult({
  notes: [
    {
      id: "note_1",
      title: "Acme discovery call",
      created_at: "2026-01-01",
      summary: "Onboarding pain.",
    },
    { id: "note_2", title: "Beta renewal", created_at: "2026-01-02" },
  ],
});

const PAIN_POINTS = agentReply({
  painPoints: [
    {
      id: "pp1",
      title: "Slow onboarding",
      detail: "Takes weeks to go live.",
      severity: "high",
    },
    {
      id: "pp2",
      title: "No ROI visibility",
      detail: "No clear metric to track.",
      severity: "critical",
    },
  ],
});

const PP_SELECTION = { selectedIds: ["pp1", "pp2"] };

const GENERATED_PIECES = [
  agentReply({
    format: "email",
    title: "Cut onboarding time",
    content: "Dear prospect, cut onboarding from weeks to days.",
  }),
  agentReply({
    format: "one-pager",
    title: "ROI at a glance",
    content: "Track ROI from day one.",
  }),
];

// ---------------------------------------------------------------------------
// Transcript step (step 1)
// ---------------------------------------------------------------------------

describe("Panel — transcript selection (step 1)", () => {
  it("renders the note list when intake is complete and select awaits signal", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "completed", select: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Acme discovery call");
    screen.getByText("Beta renewal");
    screen.getByText("Onboarding pain.");
  });

  it("fires note-selection signal with correct noteId on note click", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "completed", select: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Acme discovery call/ }),
    );

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      "note-selection",
      { noteId: "note_1" },
    ]);
  });

  it("marks only the clicked note as opening while selection is in-flight", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    const props = {
      deploymentId: "dep_1",
      logRead: true,
      connected: true,
      signalPending: false,
      stepOutputs: { intake: NOTE_LIST },
      onSignal,
      onClose: noop,
    };
    const { rerender } = render(
      <Panel
        {...props}
        state={makeState({ intake: "completed", select: "awaiting-signal" })}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Acme discovery call/ }),
    );
    rerender(
      <Panel
        {...props}
        state={makeState({ intake: "completed", select: "in-flight" })}
      />,
    );

    screen.getByRole("button", { name: /Acme discovery call.*Opening/s });
    screen.getByRole("button", { name: /Beta renewal.*Select/s });
  });

  it("disables note buttons before the select step reaches awaiting-signal", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "completed" })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    const button = screen.getByRole("button", { name: /Acme discovery call/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.click(button);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("shows a loading placeholder while intake is in-flight", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "in-flight" })}
        connected
        signalPending={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Loading your Granola notes…");
  });

  it("shows a malformed error when note-list content is invalid JSON", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "completed", select: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{ intake: { callId: "c1", content: "not-json" } }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Couldn't read the Granola note list.");
  });
});

// ---------------------------------------------------------------------------
// Context step (step 2)
// ---------------------------------------------------------------------------

describe("Panel — context input (step 2)", () => {
  it("renders the context textarea when context awaits signal", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          fetch: toolResult({
            id: "note_1",
            title: "Acme discovery call",
            summary: "Discovery",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByPlaceholderText(/focus on integration issues/i);
    screen.getByRole("button", { name: "Continue" });
  });

  it("does not rewind to the transcript group when early gate outputs are absent but context is active (CL-2506)", () => {
    // intake/select/fetch (the transcript cluster, including awaitSignal gates)
    // are missing from the synthesized state, but context is awaiting its signal:
    // the panel must show the context step, not fall back to transcript.
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ context: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          fetch: toolResult({
            id: "note_1",
            title: "Acme discovery call",
            summary: "Discovery",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );
    screen.getByPlaceholderText(/focus on integration issues/i);
    expect(screen.queryByText("Beta renewal")).toBeNull();
  });

  it("fires context signal with trimmed textarea value", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          fetch: toolResult({ id: "note_1", title: "Acme" }),
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.type(
      screen.getByPlaceholderText(/focus on integration issues/i),
      "Focus on onboarding cost",
    );
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      "context",
      { context: "Focus on onboarding cost" },
    ]);
  });

  it("allows submitting context with an empty string (optional field)", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          fetch: toolResult({ id: "note_1", title: "Acme" }),
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    // No typing — submit empty
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSignal).toHaveBeenCalledWith("context", { context: "" });
  });
});

// ---------------------------------------------------------------------------
// Pain point selection step (step 3)
// ---------------------------------------------------------------------------

describe("Panel — pain point selection (step 3)", () => {
  it("renders pain points as checkboxes when ppSelection awaits signal", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Slow onboarding");
    screen.getByText("No ROI visibility");
    screen.getByText("Takes weeks to go live.");
    screen.getByText("High");
    screen.getByText("Critical");
  });

  it("fires pain-point-selection signal with correct ids on submit", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    // Check first pain point
    const checkboxes = screen.getAllByRole("checkbox");
    await userEvent.click(checkboxes[0]!);

    // Submit with just pp1 selected
    await userEvent.click(
      screen.getByRole("button", { name: /Select 1 pain point$/ }),
    );

    expect(onSignal).toHaveBeenCalledTimes(1);
    const [signalName, payload] = onSignal.mock.calls[0] as [
      string,
      { selectedIds: string[] },
    ];
    expect(signalName).toBe("pain-point-selection");
    expect(payload.selectedIds).toContain("pp1");
  });

  it("disables submit when no pain points are selected", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    const submitBtn = screen.getByRole("button", {
      name: /Select pain points/,
    });
    expect(submitBtn.hasAttribute("disabled")).toBe(true);
  });

  it("shows a placeholder while analyze is in-flight", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "in-flight",
        })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Analyzing transcript for pain points…");
  });

  it("shows a malformed error when analyze output is not valid JSON", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: { reply: "{not valid json" },
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Couldn't read the extracted pain points.");
  });
});

// ---------------------------------------------------------------------------
// Format selection step (step 4)
// ---------------------------------------------------------------------------

describe("Panel — format selection (step 4)", () => {
  it("renders format checkboxes when fmtSelection awaits signal", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Draft a personal follow-up email to send after the call");
    screen.getByText("A sales leave-behind that stands on its own");
    screen.getByText(
      "First-person field observation for a professional audience",
    );
  });

  it("fires format-selection signal with cartesian product items on submit", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          ppSelection: PP_SELECTION,
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    // Select "Email" and "One-pager" (2 formats × 2 pain points = 4 items)
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /Draft a personal follow-up email/,
      }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: /A sales leave-behind/ }),
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Generate 2 formats/ }),
    );

    expect(onSignal).toHaveBeenCalledTimes(1);
    const [signalName, payload] = onSignal.mock.calls[0] as [
      string,
      { items: { format: string; painPointId: string }[] },
    ];
    expect(signalName).toBe("format-selection");
    expect(payload.items).toHaveLength(4);
    expect(payload.items.map((i) => i.format)).toEqual(
      expect.arrayContaining(["email", "one-pager"]),
    );
    expect(payload.items.map((i) => i.painPointId)).toEqual(
      expect.arrayContaining(["pp1", "pp2"]),
    );
  });

  it("disables submit when no formats are selected", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    const submitBtn = screen.getByRole("button", {
      name: /Generate collateral$/,
    });
    expect(submitBtn.hasAttribute("disabled")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review step (step 5)
// ---------------------------------------------------------------------------

describe("Panel — review generated pieces (step 5)", () => {
  it("renders generated pieces as approve/deny cards when review awaits signal", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "completed",
          generate: "completed",
          review: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          generate: GENERATED_PIECES,
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Cut onboarding time");
    screen.getByText(/ROI at a glance/);
    screen.getByText("Dear prospect, cut onboarding from weeks to days.");
    screen.getByText("Review queue");
    screen.getByRole("button", { name: "Approve" });
    screen.getByRole("button", { name: "Deny" });
  });

  it("fires review signal with approved and denied decisions after queue review", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "completed",
          generate: "completed",
          review: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          generate: GENERATED_PIECES,
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Save Collateral to Artifacts" }),
    );

    expect(onSignal).toHaveBeenCalledTimes(1);
    const [name, payload] = onSignal.mock.calls[0] as [
      string,
      {
        decisions: {
          format: string;
          title: string;
          content: string;
          approved: boolean;
        }[];
        approvedPieces: { format: string; title: string; content: string }[];
      },
    ];
    expect(name).toBe("review");
    expect(payload.decisions).toHaveLength(2);
    expect(payload.decisions[0]).toMatchObject({
      format: "email",
      approved: true,
    });
    expect(payload.decisions[1]).toMatchObject({
      format: "one-pager",
      approved: false,
    });
    expect(payload.approvedPieces).toHaveLength(1);
    expect(payload.approvedPieces[0]!.format).toBe("email");
  });

  it("fires review signal with all pieces when all are approved", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "completed",
          generate: "completed",
          review: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          generate: GENERATED_PIECES,
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Save Collateral to Artifacts" }),
    );

    expect(onSignal).toHaveBeenCalledTimes(1);
    const [, payload] = onSignal.mock.calls[0] as [
      string,
      {
        decisions: { format: string; approved: boolean }[];
        approvedPieces: { format: string }[];
      },
    ];
    expect(payload.decisions).toHaveLength(2);
    expect(payload.decisions.every((decision) => decision.approved)).toBe(true);
    expect(payload.approvedPieces.map((d) => d.format)).toEqual(
      expect.arrayContaining(["email", "one-pager"]),
    );
  });

  const reviewState = makeState({
    intake: "completed",
    select: "completed",
    fetch: "completed",
    context: "completed",
    analyze: "completed",
    ppSelection: "completed",
    fmtSelection: "completed",
    generate: "completed",
    review: "awaiting-signal",
  });

  const reviewOutputs = {
    intake: NOTE_LIST,
    analyze: PAIN_POINTS,
    generate: GENERATED_PIECES,
  };

  it("renders a generated piece content as parsed markdown", () => {
    const markdownPieces = [
      agentReply({
        format: "one-pager",
        title: "Cut onboarding time",
        content: "A **bold** outcome",
      }),
    ];
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={reviewState}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          generate: markdownPieces,
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    const strong = screen.getByText("bold");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.queryByText("A **bold** outcome")).toBeNull();
  });

  it("does not render a second summary list once every piece is decided", async () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={reviewState}
        connected
        signalPending={false}
        stepOutputs={reviewOutputs}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    screen.getByText("Review complete");
    // The single source of truth is the queue; the piece title appears once there.
    expect(screen.getAllByText(/Cut onboarding time/)).toHaveLength(1);
    // Approve/Deny cards are gone in the completion view.
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("Back re-opens the previous decision so it can be flipped before submit", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={reviewState}
        connected
        signalPending={false}
        stepOutputs={reviewOutputs}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    // Approve the first piece, then step back and deny it instead.
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    // First piece is active again — its content is shown.
    screen.getByText("Dear prospect, cut onboarding from weeks to days.");
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Save Collateral to Artifacts" }),
    );

    const [, payload] = onSignal.mock.calls[0] as [
      string,
      { decisions: { format: string; approved: boolean }[] },
    ];
    expect(payload.decisions[0]).toMatchObject({
      format: "email",
      approved: false,
    });
    expect(payload.decisions[1]).toMatchObject({
      format: "one-pager",
      approved: true,
    });
  });

  it("keeps Approve/Deny enabled during review while the step is awaiting-signal", () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={reviewState}
        connected
        signalPending={false}
        stepOutputs={reviewOutputs}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    const approve = screen.getByRole("button", {
      name: "Approve",
    }) as HTMLButtonElement;
    const deny = screen.getByRole("button", {
      name: "Deny",
    }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expect(deny.disabled).toBe(false);
  });

  it("disables the final submit once review goes in-flight and does not re-enable (anti-flicker)", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    const inFlightReview = makeState({
      intake: "completed",
      select: "completed",
      fetch: "completed",
      context: "completed",
      analyze: "completed",
      ppSelection: "completed",
      fmtSelection: "completed",
      generate: "completed",
      review: "in-flight",
    });
    const { rerender } = render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={reviewState}
        connected
        signalPending={false}
        stepOutputs={reviewOutputs}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    // Decide both pieces while awaiting-signal so the submit becomes reachable.
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    const submit = screen.getByRole("button", {
      name: "Save Collateral to Artifacts",
    });
    expect(submit.hasAttribute("disabled")).toBe(false);

    // The server (optimistic cache flip) reports the gate as in-flight. The submit
    // must disable and STAY disabled while in-flight — never snap back to enabled.
    // signalPending stays false throughout, proving the disable is phase-derived.
    rerender(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={inFlightReview}
        connected
        signalPending={false}
        stepOutputs={reviewOutputs}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    const savingBtn = screen.getByRole("button", { name: "Saving…" });
    expect(savingBtn.hasAttribute("disabled")).toBe(true);
    await userEvent.click(savingBtn);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("keeps the pain-point submit disabled while ppSelection is in-flight (no signalPending dependence)", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    const base = {
      intake: "completed" as const,
      select: "completed" as const,
      fetch: "completed" as const,
      context: "completed" as const,
      analyze: "completed" as const,
    };
    const { rerender } = render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ ...base, ppSelection: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(
      screen
        .getByRole("button", { name: /Select 1 pain point$/ })
        .hasAttribute("disabled"),
    ).toBe(false);

    // Cache flips to in-flight; signalPending stays false. The submit must disable.
    rerender(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ ...base, ppSelection: "in-flight" })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    const selecting = screen.getByRole("button", { name: /Selecting…/ });
    expect(selecting.hasAttribute("disabled")).toBe(true);
    await userEvent.click(selecting);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("shows a placeholder while generate is running", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "completed",
          generate: "in-flight",
        })}
        connected
        signalPending={false}
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    // Shown both as the body placeholder and on the persistent live status line.
    expect(
      screen.getAllByText("Generating collateral…").length,
    ).toBeGreaterThan(0);
  });

  it("reads generated pieces wrapped in a JSON markdown fence", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "completed",
          generate: "completed",
          review: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          generate: [
            {
              reply: `\`\`\`json
{"format":"email","title":"Cut onboarding time","content":"Dear prospect, cut onboarding from weeks to days."}
\`\`\``,
            },
          ],
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Cut onboarding time");
    screen.getByText("Dear prospect, cut onboarding from weeks to days.");
  });

  function renderReviewWithReply(reply: string) {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "completed",
          generate: "completed",
          review: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          generate: [{ reply }],
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );
  }

  const PIECE_JSON =
    '{"format":"email","title":"Cut onboarding time","content":"Dear prospect, cut onboarding from weeks to days."}';

  it("reads a plain strict JSON reply with no fence", () => {
    renderReviewWithReply(PIECE_JSON);
    screen.getByText("Cut onboarding time");
    screen.getByText("Dear prospect, cut onboarding from weeks to days.");
  });

  it("reads a reply fenced with ``` and no language tag", () => {
    renderReviewWithReply(`\`\`\`\n${PIECE_JSON}\n\`\`\``);
    screen.getByText("Cut onboarding time");
    screen.getByText("Dear prospect, cut onboarding from weeks to days.");
  });

  it("reads a fenced JSON reply with prose preamble and postamble", () => {
    renderReviewWithReply(
      `Here's your collateral:\n\n\`\`\`json\n${PIECE_JSON}\n\`\`\`\n\nLet me know if you want changes!`,
    );
    screen.getByText("Cut onboarding time");
    screen.getByText("Dear prospect, cut onboarding from weeks to days.");
  });

  it("reads a reply fenced with ~~~ tildes", () => {
    renderReviewWithReply(`~~~json\n${PIECE_JSON}\n~~~`);
    screen.getByText("Cut onboarding time");
    screen.getByText("Dear prospect, cut onboarding from weeks to days.");
  });

  it("reads a reply with leading and trailing whitespace around the fence", () => {
    renderReviewWithReply(`\n\n   \`\`\`json\n${PIECE_JSON}\n\`\`\`   \n\n`);
    screen.getByText("Cut onboarding time");
    screen.getByText("Dear prospect, cut onboarding from weeks to days.");
  });

  it("reads a raw JSON object embedded in prose with no fence", () => {
    renderReviewWithReply(
      `Sure thing — here it is: ${PIECE_JSON} Hope that helps.`,
    );
    screen.getByText("Cut onboarding time");
    screen.getByText("Dear prospect, cut onboarding from weeks to days.");
  });

  it("shows a placeholder (pending) when the generated reply is empty", () => {
    renderReviewWithReply("   ");
    screen.getByText("Couldn't read the generated collateral.");
  });

  it("shows a malformed error when the reply contains no JSON at all", () => {
    renderReviewWithReply(
      "Sorry, I could not produce any collateral this time.",
    );
    screen.getByText("Couldn't read the generated collateral.");
  });

  it("shows a malformed error when generated pieces are not valid", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "completed",
          generate: "completed",
          review: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          generate: [{ reply: "{bad json" }],
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Couldn't read the generated collateral.");
  });
});

// ---------------------------------------------------------------------------
// Done step (step 6)
// ---------------------------------------------------------------------------

describe("Panel — done (step 6)", () => {
  it("shows artifact titles when persist is complete", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "completed",
          analyze: "completed",
          ppSelection: "completed",
          fmtSelection: "completed",
          generate: "completed",
          review: "completed",
          persist: "completed",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          generate: GENERATED_PIECES,
          review: {
            decisions: [
              {
                format: "email",
                title: "Cut onboarding time",
                content: "Hi...",
                approved: true,
              },
              {
                format: "one-pager",
                title: "ROI at a glance",
                content: "Track...",
                approved: false,
              },
            ],
          },
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Cut onboarding time");
    screen.getByText(/ROI at a glance/);
    screen.getByText("Approved artifacts created successfully.");
    screen.getByText("Approved");
    screen.getByText("Denied");
  });
});

// ---------------------------------------------------------------------------
// Error and close
// ---------------------------------------------------------------------------

describe("Panel — error and close", () => {
  it("renders an error banner when a step has failed", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "completed", analyze: "failed" }, "failed")}
        connected
        signalPending={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Run failed at Pain points");
    screen.getByText(/No error details are available/);
  });

  it("shows the sanitized step error, never raw internals (CL-2659)", () => {
    const state = makeState(
      { intake: "completed", analyze: "failed" },
      "failed",
    );
    const failedStep = state.steps.get("analyze") as unknown as {
      lastError?: { message: string };
    };
    failedStep.lastError = {
      message:
        "TypeError: boom at run (ins_01abc/ses_01def) /app/steps/analyze.ts:42:7",
    };
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={state}
        connected
        signalPending={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Run failed at Pain points");
    screen.getByText(/Something went wrong inside this workflow run/);
    expect(screen.queryByText(/ins_/)).toBeNull();
    expect(screen.queryByText(/ses_/)).toBeNull();
    expect(screen.queryByText(/TypeError/)).toBeNull();
  });

  it("invokes onClose when the header close button is clicked", async () => {
    const onClose = mock(() => {});
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "in-flight" })}
        connected
        signalPending={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={onClose}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows disconnected status when connected is false", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "in-flight" })}
        connected={false}
        signalPending={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Reconnecting…");
  });
});

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

describe("Panel — stepper reflects run progress", () => {
  it("marks steps as completed up to the active one", () => {
    render(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          select: "completed",
          fetch: "completed",
          context: "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          intake: NOTE_LIST,
          fetch: toolResult({ id: "note_1", title: "Acme call" }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    // Context step should be visible (active area renders context form)
    screen.getByPlaceholderText(/focus on integration issues/i);
  });
});
