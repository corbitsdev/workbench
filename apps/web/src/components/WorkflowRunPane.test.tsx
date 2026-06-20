/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, it, expect, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowPanelProps } from "@workbench/ui";
import type { RunState, StepState } from "@intx/workflow";
import * as workflowHooks from "../hooks/use-workflow";

// Captured before mock.module rebinds the module so the fallback below calls the
// genuine fetchStepOutput, not itself.
const realFetchStepOutput = workflowHooks.fetchStepOutput;

function CustomPanel({ deploymentId, stepOutputs }: WorkflowPanelProps) {
  return (
    <div>
      <span>custom-panel-for-{deploymentId}</span>
      {Object.entries(stepOutputs).map(([stepId, output]) => (
        <span key={stepId}>
          out-{stepId}:{JSON.stringify(output)}
        </span>
      ))}
    </div>
  );
}

mock.module("../lib/workflow-ui", () => ({
  loadWorkflowUI: async (kind: string) => {
    if (kind === "with-panel") return { Panel: CustomPanel };
    return {};
  },
}));

// Mock the per-step fetch at the hook module boundary so the pane's
// allSettled resolver is exercised without touching the global fetch (which
// other test files rely on). dep-mixed has three completed steps: one good,
// one whose payload parse fails, and one that rejects outright.
// bun's mock.module registry is global, so this override leaks into any suite
// that imports the real module after us. Delegate unrecognized calls to the
// real fetchStepOutput so sibling suites (e.g. use-workflow.test) are unaffected.
const stepOutputMock = mock((deploymentId: string, stepId: string) => {
  if (stepId === "step-ok") return Promise.resolve({ headline: "hi" });
  if (stepId === "step-bad")
    return Promise.reject(new Error("Unexpected step-output response"));
  if (stepId === "step-fail") return Promise.reject(new Error("boom"));
  return realFetchStepOutput(deploymentId, stepId);
});

function step(stepId: string): StepState {
  return {
    stepId,
    phase: "completed",
    outputRef: `inline:${stepId}`,
    currentAttempt: 1,
  } as unknown as StepState;
}

function mixedRunState(): RunState {
  return {
    runId: "run-mixed",
    phase: "running",
    steps: new Map([
      ["step-ok", step("step-ok")],
      ["step-bad", step("step-bad")],
      ["step-fail", step("step-fail")],
      // A still-running step carries no output ref and must not be queried.
      [
        "step-pending",
        {
          stepId: "step-pending",
          phase: "running",
          currentAttempt: 1,
        } as unknown as StepState,
      ],
    ]),
  } as RunState;
}

let runState: RunState | null = null;

// Spread the real module so untouched exports (e.g. useStepOutput) keep their
// real implementations — bun's mock.module registry is global, so replacing the
// whole module would leak undefined exports into other suites.
mock.module("../hooks/use-workflow", () => ({
  ...workflowHooks,
  useWorkflowRuns: () => ({
    data: [
      {
        deploymentId: "dep-panel",
        kind: "with-panel",
        status: "active",
        createdAt: "",
      },
      {
        deploymentId: "dep-plain",
        kind: "no-panel",
        status: "active",
        createdAt: "",
      },
      {
        deploymentId: "dep-mixed",
        kind: "with-panel",
        status: "active",
        createdAt: "",
      },
    ],
    isPending: false,
  }),
  useWorkflowRunState: () => ({ state: runState, events: [], connected: true }),
  useSignalWorkflow: () => ({
    mutateAsync: async () => undefined,
    isPending: false,
  }),
  fetchStepOutput: stepOutputMock,
}));

import { WorkflowRunPane } from "./WorkflowRunPane";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("WorkflowRunPane", () => {
  afterEach(() => {
    cleanup();
    runState = null;
    stepOutputMock.mockClear();
  });

  it("renders the workflow kind own Panel when its module exports one", async () => {
    render(
      <WorkflowRunPane deploymentId="dep-panel" onClose={() => undefined} />,
      { wrapper },
    );
    await waitFor(() => screen.getByText("custom-panel-for-dep-panel"));
  });

  it("falls back to RunConsole when the module has no Panel", async () => {
    render(
      <WorkflowRunPane deploymentId="dep-plain" onClose={() => undefined} />,
      { wrapper },
    );
    await waitFor(() => screen.getByText("Workflow run"));
    expect(screen.queryByText("custom-panel-for-dep-plain")).toBeNull();
  });

  it("does not query step outputs when there are no completed steps with an output ref", async () => {
    runState = null;
    render(
      <WorkflowRunPane deploymentId="dep-mixed" onClose={() => undefined} />,
      { wrapper },
    );
    await waitFor(() => screen.getByText("custom-panel-for-dep-mixed"));
    expect(stepOutputMock).not.toHaveBeenCalled();
  });

  it("passes a successful step output to the Panel and one bad step does not blank the others", async () => {
    runState = mixedRunState();
    render(
      <WorkflowRunPane deploymentId="dep-mixed" onClose={() => undefined} />,
      { wrapper },
    );

    // The good step's output is delivered to the panel...
    await waitFor(() => screen.getByText('out-step-ok:{"headline":"hi"}'));

    // ...while the malformed and failing steps are absent from the map, not
    // blanking the surviving section.
    expect(screen.queryByText(/out-step-bad/)).toBeNull();
    expect(screen.queryByText(/out-step-fail/)).toBeNull();

    // The still-running step (no output ref) is never fetched.
    const queriedStepIds = stepOutputMock.mock.calls.map((c) => c[1]);
    expect(queriedStepIds).not.toContain("step-pending");
    expect(queriedStepIds).toContain("step-ok");
  });
});
