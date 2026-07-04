/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as workflowHooks from "../hooks/use-workflow";
import type { LogRunState, RunRecord } from "../lib/run-state-adapter";

let record: RunRecord | null = null;
// The console's timeline + run phase come from the log-derived state (CL-2669).
let logStateData: LogRunState | undefined;
const resumeMutateAsync = mock(async () => undefined);

mock.module("../hooks/use-workflow", () => ({
  ...workflowHooks,
  useWorkflowRecord: () => ({ data: record ?? undefined, isLoading: false }),
  useWorkflowRunState: () => ({ data: logStateData, isError: false }),
  useResumeWorkflow: () => ({
    mutateAsync: resumeMutateAsync,
    isPending: false,
  }),
}));

import { RunConsole } from "./RunConsole";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function makeRecord(over: Partial<RunRecord>): RunRecord {
  return {
    runId: "wfr_1",
    kind: "no-panel",
    status: "failed",
    ...over,
  };
}

function makeLogState(over: Partial<LogRunState>): LogRunState {
  return {
    runId: "wfr_1",
    phase: "failed",
    lastSeq: 1,
    steps: [],
    ...over,
  };
}

const GENERIC = /this run failed\. start a new run to try again\./i;

describe("RunConsole", () => {
  afterEach(() => {
    cleanup();
    record = null;
    logStateData = undefined;
    resumeMutateAsync.mockClear();
  });

  it("shows the generic failure copy for a failed run (driven by the log phase)", () => {
    record = makeRecord({ status: "failed" });
    logStateData = makeLogState({ phase: "failed" });
    render(<RunConsole deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    screen.getByText(GENERIC);
  });

  it("renders an interrupted affordance when the index is failed but the log is still in-flight (abort/restart)", () => {
    // Repro of Finding A: an operator abort / restart-reconcile writes
    // status=failed to the INDEX only; the log's last event is a StepStarted, so
    // the fold yields phase=running with a step stuck in-flight. Without the
    // overlay the pane showed a frozen in-flight stepper and NO failure copy.
    record = makeRecord({ status: "failed" });
    logStateData = makeLogState({
      phase: "running",
      steps: [
        {
          stepId: "draft",
          phase: "in-flight",
          stepType: "agent",
          currentAttempt: 1,
        },
      ],
    });
    render(<RunConsole deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    // The interrupted affordance + restart CTA — not a silent frozen stepper.
    screen.getByText(/interrupted and can't continue/i);
    screen.getByRole("button", { name: "Start a new run" });
    // The generic "This run failed" copy is NOT shown for an interruption.
    expect(screen.queryByText(GENERIC)).toBeNull();
    // The log still drives per-step detail: the step it died on is rendered.
    screen.getByText("Draft");
  });

  it("renders each log step in the timeline with its phase", () => {
    record = makeRecord({ status: "running" });
    logStateData = makeLogState({
      phase: "running",
      steps: [
        {
          stepId: "plan",
          phase: "completed",
          stepType: "agent",
          currentAttempt: 1,
        },
        {
          stepId: "review",
          phase: "awaiting-signal",
          stepType: "human",
          currentAttempt: 1,
          awaitingSignalName: "approve",
        },
      ],
    });
    render(<RunConsole deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    screen.getByText("Plan");
    screen.getByText("Review");
    // The awaiting-signal step surfaces its Approve gate action.
    screen.getByRole("button", { name: "Approve" });
  });

  it("sanitizes a failed step's error — internal identifiers never render (CL-2660)", () => {
    record = makeRecord({ status: "failed" });
    logStateData = makeLogState({
      phase: "failed",
      steps: [
        {
          stepId: "sync",
          phase: "failed",
          stepType: "deterministic",
          currentAttempt: 1,
          lastError: {
            message: "no agent address registered for ins_ses_01aabbcc",
          },
        },
      ],
    });
    render(<RunConsole deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    expect(screen.queryByText(/ins_ses_/)).toBeNull();
    screen.getByText(/something went wrong inside this workflow run/i);
  });

  it("renders a plain-language message for a known external API failure (CL-2660)", () => {
    record = makeRecord({ status: "failed" });
    logStateData = makeLogState({
      phase: "failed",
      steps: [
        {
          stepId: "sync",
          phase: "failed",
          stepType: "deterministic",
          currentAttempt: 1,
          lastError: { message: "Attio API error: 429 too many requests" },
        },
      ],
    });
    render(<RunConsole deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    expect(screen.queryByText(/API error/)).toBeNull();
    screen.getByText(/Attio is rate-limiting requests right now/i);
  });

  it("gives each step dot a color transition so live phase changes ease instead of hard-cutting (CL-2781)", () => {
    record = makeRecord({ status: "running" });
    logStateData = makeLogState({
      phase: "running",
      steps: [
        {
          stepId: "plan",
          phase: "completed",
          stepType: "agent",
          currentAttempt: 1,
        },
      ],
    });
    const { container } = render(
      <RunConsole deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    const dot = container.querySelector("span.rounded-full");
    expect(dot).not.toBeNull();
    // The dot must animate its color (transition-colors), and still carry the
    // phase color class so the two compose rather than one replacing the other.
    expect(dot?.className).toContain("transition-colors");
    expect(dot?.className).toContain("bg-green-500");
    // The step row itself also transitions its border/background on phase change.
    const row = container.querySelector("li");
    expect(row?.className).toContain("transition-colors");
  });

  it("shows a live animated Starting… state for a provisioning run, not a frozen 'no steps' panel (CL-2755)", () => {
    record = makeRecord({ status: "provisioning" });
    logStateData = undefined;
    const { container } = render(
      <RunConsole deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    expect(screen.getByTestId("workflow-starting-indicator")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    // The static empty-state copy must not be what a starting run shows.
    expect(screen.queryByText("No steps have started yet.")).toBeNull();
  });
});
