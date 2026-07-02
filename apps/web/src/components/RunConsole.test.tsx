/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, it, mock } from "bun:test";
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
});
