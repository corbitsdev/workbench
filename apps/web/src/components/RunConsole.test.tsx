/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, it, expect, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as workflowHooks from "../hooks/use-workflow";
import type { RunRecord } from "../lib/run-state-adapter";

let record: RunRecord | null = null;
const resumeMutateAsync = mock(async () => undefined);

mock.module("../hooks/use-workflow", () => ({
  ...workflowHooks,
  useWorkflowRecord: () => ({ data: record ?? undefined, isLoading: false }),
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
    currentStepId: "plan",
    outputs: {},
    ...over,
  };
}

const INTERRUPTED = /interrupted by a restart/i;
const GENERIC = /this run failed\. start a new run to try again\./i;

describe("RunConsole interrupted-by-restart state", () => {
  afterEach(() => {
    cleanup();
    record = null;
    resumeMutateAsync.mockClear();
  });

  it("shows the interrupted message + restart CTA only for the interrupted-by-restart error", () => {
    record = makeRecord({ error: "interrupted by restart" });
    const onClose = mock(() => undefined);
    render(<RunConsole deploymentId="wfr_1" onClose={onClose} />, { wrapper });

    screen.getByText(INTERRUPTED);
    expect(screen.queryByText(GENERIC)).toBeNull();

    // The CTA routes back to the start surface via onClose.
    screen.getByRole("button", { name: "Start a new run" }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the generic failure copy (no restart CTA) for a different failure error", () => {
    record = makeRecord({ error: "tool exploded" });
    render(<RunConsole deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });

    screen.getByText(GENERIC);
    expect(screen.queryByText(INTERRUPTED)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Start a new run" }),
    ).toBeNull();
  });

  it("shows the generic failure copy for a failed run with no error string", () => {
    record = makeRecord({ error: undefined });
    render(<RunConsole deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });

    screen.getByText(GENERIC);
    expect(screen.queryByText(INTERRUPTED)).toBeNull();
  });
});
