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

function toolResult(value: unknown): { callId: string; content: string } {
  return { callId: "c1", content: JSON.stringify(value) };
}

function agentReply(value: unknown): { reply: string } {
  return { reply: JSON.stringify(value) };
}

const BRIEF = {
  title: "Acme — account brief",
  content: "## Account summary\nAcme builds **things**.",
  contactsCsv: "name,title,email,x_handle\nAda,,,",
  slackDraft: "Acme is worth a look this quarter.",
};

const baseProps = {
  logRead: true,
  deploymentId: "dep_1",
  connected: true,
  signalPending: false,
  onClose: noop,
};

describe("Panel — account intake", () => {
  it("renders the intake form when intake awaits its signal", () => {
    render(
      <Panel
        {...baseProps}
        state={makeState({ intake: "awaiting-signal" })}
        stepOutputs={{}}
        onSignal={noop}
      />,
    );
    screen.getByText("Which account should we research?");
    screen.getByPlaceholderText("acme.com");
    screen.getByRole("button", { name: "Research account" });
  });

  it("fires the intake signal with the domain and pushToAttio flag", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        {...baseProps}
        state={makeState({ intake: "awaiting-signal" })}
        stepOutputs={{}}
        onSignal={onSignal}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText("acme.com"), "acme.com");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(
      screen.getByRole("button", { name: "Research account" }),
    );

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      "intake",
      { organizationDomain: "acme.com", pushToAttio: true },
    ]);
  });

  it("keeps the submit disabled until a domain is entered", () => {
    render(
      <Panel
        {...baseProps}
        state={makeState({ intake: "awaiting-signal" })}
        stepOutputs={{}}
        onSignal={noop}
      />,
    );
    const button = screen.getByRole("button", { name: "Research account" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

describe("Panel — research progress", () => {
  it("shows the resolved account name while research runs", () => {
    render(
      <Panel
        {...baseProps}
        state={makeState({ intake: "completed", resolve: "in-flight" })}
        stepOutputs={{
          resolve: toolResult({ name: "Acme Inc", slug: "acme" }),
        }}
        onSignal={noop}
      />,
    );
    screen.getByText("Researching the account");
    screen.getByText("Acme Inc");
  });

  it("shows an error when resolve fails", () => {
    render(
      <Panel
        {...baseProps}
        state={makeState({ intake: "completed", resolve: "failed" })}
        stepOutputs={{}}
        onSignal={noop}
      />,
    );
    screen.getByText("Couldn't resolve that account.");
  });
});

describe("Panel — brief review", () => {
  const reviewState = makeState({
    intake: "completed",
    resolve: "completed",
    teams: "completed",
    jobs: "completed",
    techStack: "completed",
    contacts: "completed",
    signals: "completed",
    enrichSocial: "completed",
    synthesize: "completed",
    review: "awaiting-signal",
  });

  it("renders the brief content as markdown with the Slack draft", () => {
    render(
      <Panel
        {...baseProps}
        state={reviewState}
        stepOutputs={{ synthesize: agentReply(BRIEF) }}
        onSignal={noop}
      />,
    );
    screen.getByText("Acme — account brief");
    const strong = screen.getByText("things");
    expect(strong.tagName).toBe("STRONG");
    screen.getByText("Acme is worth a look this quarter.");
    screen.getByRole("button", { name: "Approve & save" });
  });

  it("fires the review signal with approved true, carrying the intake pushToAttio flag", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        {...baseProps}
        state={reviewState}
        stepOutputs={{
          synthesize: agentReply(BRIEF),
          intake: { organizationDomain: "acme.com", pushToAttio: true },
        }}
        onSignal={onSignal}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Approve & save" }),
    );

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      "review",
      { approved: true, pushToAttio: true },
    ]);
  });

  it("fires the review signal with approved false on reject", async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        {...baseProps}
        state={reviewState}
        stepOutputs={{ synthesize: agentReply(BRIEF) }}
        onSignal={onSignal}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    const [name, payload] = onSignal.mock.calls[0] as [
      string,
      { approved: boolean },
    ];
    expect(name).toBe("review");
    expect(payload.approved).toBe(false);
  });

  it("shows a spinner while synthesize is still running", () => {
    render(
      <Panel
        {...baseProps}
        state={makeState({
          intake: "completed",
          resolve: "completed",
          teams: "completed",
          jobs: "completed",
          techStack: "completed",
          contacts: "completed",
          signals: "completed",
          enrichSocial: "completed",
          synthesize: "in-flight",
        })}
        stepOutputs={{}}
        onSignal={noop}
      />,
    );
    screen.getByText("Writing the account brief");
  });
});

describe("Panel — failure and close", () => {
  it("renders a failure card when the run fails", () => {
    render(
      <Panel
        {...baseProps}
        state={makeState({ intake: "completed", resolve: "failed" }, "failed")}
        stepOutputs={{}}
        onSignal={noop}
      />,
    );
    screen.getByText("This run failed.");
  });

  it("invokes onClose from the header close button", async () => {
    const onClose = mock(() => {});
    render(
      <Panel
        {...baseProps}
        state={makeState({ intake: "awaiting-signal" })}
        stepOutputs={{}}
        onSignal={noop}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
