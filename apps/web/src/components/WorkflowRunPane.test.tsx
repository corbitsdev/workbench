/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, it, expect, mock } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { ActiveContextProvider } from "../lib/active-context-store";
import {
  PageChromeProvider,
  usePageChromeSlot,
  useSetPageChrome,
} from "../lib/page-chrome";
import type { WorkflowPanelProps } from "@workbench/ui";
import * as workflowHooks from "../hooks/use-workflow";
import type { LogRunState, RunRecord } from "../lib/run-state-adapter";

function CustomPanel({
  deploymentId,
  stepOutputs,
  signalPending,
  connected,
  skills,
  onSignal,
}: WorkflowPanelProps) {
  return (
    <div>
      <span>custom-panel-for-{deploymentId}</span>
      <span>signal-pending:{String(signalPending)}</span>
      <span>connected:{String(connected)}</span>
      <span>
        skills:
        {(skills ?? [])
          .map((skill) => skill.displayName ?? skill.name)
          .join(",")}
      </span>
      {Object.entries(stepOutputs).map(([stepId, output]) => (
        <span key={stepId}>
          out-{stepId}:{JSON.stringify(output)}
        </span>
      ))}
      <button
        disabled={signalPending}
        onClick={() => onSignal("approve", { ok: true })}
      >
        fire-signal
      </button>
    </div>
  );
}

// A controllable deferred so a test can hold the custom-Panel module in a
// PENDING state at the provisioning→running flip and assert no generic-shell
// flash (CL-2755 handoff flicker).
let resolveSlowPanel: (() => void) | null = null;
mock.module("../lib/workflow-ui", () => ({
  loadWorkflowUI: async (kind: string) => {
    if (kind === "with-panel") return { Panel: CustomPanel };
    if (kind === "slow-panel") {
      await new Promise<void>((resolve) => {
        resolveSlowPanel = resolve;
      });
      return { Panel: CustomPanel };
    }
    return {};
  },
}));

// Record served by the mocked record hook, swapped per test.
let record: RunRecord | null = null;
let isLoading = false;
let isError = false;
let deployments: workflowHooks.WorkflowDeployment[] = [];
// The log-derived run state drives the stepper; step content comes from the
// log-served step outputs (CL-2669). Both swapped per test.
let logStateData: LogRunState | undefined = {
  runId: "wfr_1",
  phase: "running",
  lastSeq: 1,
  steps: [],
};
let logStateError = false;
let stepOutputsData: Record<string, unknown> = {};
// The id the pane keys the step-output hook by — must be the RUN id, never the
// record's ses_ deploymentId (which 404s under per-run deployments, CL-2704).
let stepOutputsRequestedId: string | null | undefined;

const resumeMutateAsync = mock(
  async (_vars?: {
    signalName?: string;
    payload?: unknown;
    onRedeploying?: () => void;
  }): Promise<undefined> => undefined,
);
const stopMutate = mock((_runId: string) => undefined);
let stopIsError = false;

mock.module("../hooks/use-workflow", () => ({
  ...workflowHooks,
  useWorkflowRecord: () => ({ data: record ?? undefined, isLoading, isError }),
  useWorkflowRunState: () => ({ data: logStateData, isError: logStateError }),
  useWorkflowStepOutputs: (runId: string | null | undefined) => {
    stepOutputsRequestedId = runId;
    return { data: stepOutputsData };
  },
  useResumeWorkflow: () => ({
    mutateAsync: resumeMutateAsync,
    isPending: false,
  }),
  useStopWorkflowRun: () => ({
    mutate: stopMutate,
    isPending: false,
    isError: stopIsError,
    variables: undefined,
  }),
  useWorkflowCredentials: () => ({ data: [] }),
  useWorkflowDeployments: () => ({ data: deployments }),
}));

// No test in this file exercises the catalog-driven full step sequence (that
// lives in WorkflowRunBlocks.test.tsx); stub it out so the pane doesn't fire a
// real network request in every render here.
mock.module("../hooks/use-workflows-catalog", () => ({
  useWorkflowsCatalog: () => ({ data: undefined }),
}));

mock.module("../hooks/use-skills", () => ({
  useSkillLibrary: () => ({
    data: [
      {
        id: "skill_1",
        name: "hammy-humanizer",
        displayName: "Hammy Humanizer",
      },
    ],
  }),
}));

import { WorkflowRunPane } from "./WorkflowRunPane";

function ChromeSlotProbe() {
  return <div data-testid="chrome-slot">{usePageChromeSlot()}</div>;
}

// Stands in for a host page (e.g. WorkflowsPage) that publishes its own
// stable chrome node unconditionally, the way `useSetPageChrome(chrome)`
// (default `enabled: true`) is used at the page level.
function HostChromePublisher() {
  useSetPageChrome(<div>Host Chrome</div>);
  return null;
}

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ActiveContextProvider>
        <PageChromeProvider>
          <ChromeSlotProbe />
          {children}
        </PageChromeProvider>
      </ActiveContextProvider>
    </QueryClientProvider>
  );
}

function makeRecord(over: Partial<RunRecord>): RunRecord {
  return {
    runId: "wfr_1",
    kind: "with-panel",
    status: "awaiting",
    ...over,
  };
}

describe("WorkflowRunPane", () => {
  afterEach(() => {
    cleanup();
    record = null;
    isLoading = false;
    isError = false;
    deployments = [];
    logStateData = { runId: "wfr_1", phase: "running", lastSeq: 1, steps: [] };
    logStateError = false;
    stepOutputsData = {};
    stepOutputsRequestedId = undefined;
    resumeMutateAsync.mockReset();
    resumeMutateAsync.mockImplementation(async () => undefined);
    stopMutate.mockReset();
    stopIsError = false;
    resolveSlowPanel = null;
  });

  it("shows Stop in chrome for live runs and two-step confirms (CL-3687)", async () => {
    record = makeRecord({ status: "running" });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByTestId("run-pane-stop"));
    fireEvent.click(screen.getByTestId("run-pane-stop"));
    expect(stopMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("run-pane-stop-confirm"));
    expect(stopMutate).toHaveBeenCalledWith("wfr_1");
  });

  it("surfaces a legible error when the stop request fails (CL-3687)", async () => {
    record = makeRecord({ status: "running" });
    stopIsError = true;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("Couldn't stop this run. Try again."));
    // Stop stays available so the user can retry.
    expect(screen.getByTestId("run-pane-stop")).toBeTruthy();
  });

  it("hides Stop in chrome for terminal runs (CL-3687)", async () => {
    record = makeRecord({ status: "stopped" });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByTestId("chrome-slot"));
    expect(screen.queryByTestId("run-pane-stop")).toBeNull();
  });

  it("does not clear a host page's chrome when embedded (CL-4420)", async () => {
    // Regression: an embedded pane used to call useSetPageChrome(record ? runChrome
    // : null) unconditionally, so once `record` loaded it clobbered whatever the
    // host page (e.g. WorkflowsPage) had already published with `null` — and
    // since the host's own chrome node is memoized (stable identity), its effect
    // never re-fired to restore it, so the title stayed blank. The fix passes
    // `!embedded` as `useSetPageChrome`'s `enabled` arg so an embedded pane never
    // touches the shared chrome slot at all.
    record = makeRecord({ status: "running" });
    render(
      <>
        <HostChromePublisher />
        <WorkflowRunPane
          deploymentId="wfr_1"
          onClose={() => undefined}
          embedded
        />
      </>,
      { wrapper },
    );
    // Give the pane's effects (including its own chrome effect) a chance to run.
    // Embedded mode always skips the kind's own Panel (`Panel = embedded ?
    // undefined : uiModule?.Panel`), so this lands on the generic
    // WorkflowRunBlocks fallback, not the custom Panel.
    await waitFor(() => screen.getByText("Waiting for run activity…"));
    expect(screen.getByTestId("chrome-slot").textContent).toBe("Host Chrome");
  });

  it("still offers Stop inline when embedded, even parked on a gate (CL-4570)", async () => {
    // Embedded mode (WorkflowsPage's list inspector) never publishes page
    // chrome, so a run parked on a gate there had no way to stop it — the gate
    // form was the only affordance. Stop must render inline instead.
    record = makeRecord({ status: "awaiting" });
    render(
      <WorkflowRunPane
        deploymentId="wfr_1"
        onClose={() => undefined}
        embedded
      />,
      { wrapper },
    );
    await waitFor(() => screen.getByTestId("run-pane-stop"));
    fireEvent.click(screen.getByTestId("run-pane-stop"));
    fireEvent.click(screen.getByTestId("run-pane-stop-confirm"));
    expect(stopMutate).toHaveBeenCalledWith("wfr_1");
  });

  it("hides the embedded inline Stop bar for terminal runs (CL-4570)", async () => {
    record = makeRecord({ status: "completed" });
    render(
      <WorkflowRunPane
        deploymentId="wfr_1"
        onClose={() => undefined}
        embedded
      />,
      { wrapper },
    );
    await waitFor(() => screen.getByTestId("chrome-slot"));
    expect(screen.queryByTestId("run-pane-stop")).toBeNull();
  });

  it("publishes its own chrome (Stop control) when NOT embedded, confirming the gate is real", async () => {
    record = makeRecord({ status: "running" });
    render(
      <>
        <HostChromePublisher />
        <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />
      </>,
      { wrapper },
    );
    await waitFor(() => screen.getByTestId("run-pane-stop"));
    // Non-embedded pane DOES own the chrome slot, overwriting the host's node —
    // proves the assertion above is exercising a real conditional, not a tautology.
    expect(screen.getByTestId("chrome-slot").textContent).not.toBe(
      "Host Chrome",
    );
  });

  it("renders the workflow kind own Panel when its module exports one", async () => {
    record = makeRecord({});
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("custom-panel-for-wfr_1"));
  });

  it("falls back to the generic WorkflowRunBlocks view when the module has no Panel", async () => {
    record = makeRecord({ kind: "no-panel" });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("Waiting for run activity…"));
    expect(screen.queryByText("custom-panel-for-wfr_1")).toBeNull();
  });

  it("resumes with the gate's signal name when a block gate is approved in the fallback view", async () => {
    record = makeRecord({ kind: "no-panel", status: "awaiting" });
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "select",
          phase: "awaiting-signal",
          stepType: "human",
          currentAttempt: 1,
          awaitingSignalName: "note-selection",
        },
      ],
    };
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Continue"));
    await waitFor(() => expect(resumeMutateAsync).toHaveBeenCalledTimes(1));
    expect(resumeMutateAsync.mock.calls[0]?.[0]?.signalName).toBe(
      "note-selection",
    );
  });

  it("does NOT fire a resume from a block gate once the run is terminal", async () => {
    record = makeRecord({ kind: "no-panel", status: "failed" });
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "select",
          phase: "awaiting-signal",
          stepType: "human",
          currentAttempt: 1,
          awaitingSignalName: "note-selection",
        },
      ],
    };
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Continue"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(resumeMutateAsync).not.toHaveBeenCalled();
  });

  it("falls back to a legible run state when the log query errors, instead of hanging on Loading workflow…", async () => {
    // Repro of Finding B: a legacy run (no deploymentId) 400s on /state, so the
    // log query errors and logState is undefined. The pane used to sit on
    // "Loading workflow…" forever. It must fall back to the record-derived run-level
    // state and render the terminal failure copy.
    record = makeRecord({ kind: "no-panel", status: "failed" });
    logStateData = undefined;
    logStateError = true;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() =>
      screen.getByText(/this run failed\. start a new run to try again\./i),
    );
    expect(screen.queryByText("Loading workflow…")).toBeNull();
  });

  it("keeps showing Loading workflow… while the log is genuinely still loading (no error, deployment present)", () => {
    // The fallback must NOT fire while the log is merely in flight — only on a
    // real error / missing deployment. A run with a deploymentId and no error is
    // still loading and should show the placeholder.
    record = makeRecord({
      kind: "no-panel",
      status: "running",
      deploymentId: "ses_d",
    });
    logStateData = undefined;
    logStateError = false;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    screen.getByText("Loading workflow…");
  });

  it("shows the loading placeholder while the record query is loading", () => {
    isLoading = true;
    record = null;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    screen.getByText("Loading workflow…");
    expect(screen.queryByText("custom-panel-for-wfr_1")).toBeNull();
  });

  it("shows an error message when the record query errors", () => {
    isError = true;
    record = null;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    screen.getByText(/couldn't load this workflow run/i);
  });

  it("renders empty deploymentId as a loading placeholder without firing resume", () => {
    render(<WorkflowRunPane deploymentId="" onClose={() => undefined} />, {
      wrapper,
    });
    screen.getByText("Loading…");
    expect(resumeMutateAsync).not.toHaveBeenCalled();
  });

  it("hands the log-served step outputs and skill library straight to the Panel", async () => {
    record = makeRecord({});
    stepOutputsData = { "step-ok": { headline: "hi" } };
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText('out-step-ok:{"headline":"hi"}'));
    screen.getByText("skills:Hammy Humanizer");
  });

  it("keys step outputs by the RUN id, never the record's per-run ses_ deploymentId (CL-2704)", async () => {
    record = makeRecord({ deploymentId: "ses_perrun1" });
    stepOutputsData = { analyze: { reply: "hi" } };
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText('out-analyze:{"reply":"hi"}'));
    expect(stepOutputsRequestedId).toBe("wfr_1");
  });

  it("onSignal resumes when the run is awaiting", async () => {
    record = makeRecord({ status: "awaiting" });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("fire-signal"));
    screen.getByText("fire-signal").click();
    await waitFor(() => expect(resumeMutateAsync).toHaveBeenCalledTimes(1));
    const call = resumeMutateAsync.mock.calls[0]?.[0];
    expect(call?.signalName).toBe("approve");
    expect(call?.payload).toEqual({ ok: true });
    expect(typeof call?.onRedeploying).toBe("function");
  });

  it("latches signalPending after the resume resolves and clears it only once the signalled gate is consumed", async () => {
    // CL-2764: the /resume POST only DELIVERS the signal; the run advances past
    // the gate seconds later on the next poll. The pending latch must survive the
    // POST resolving so the gate button stays disabled + "Working…" until the
    // signal we submitted leaves the awaiting-signal set — never re-enabling on
    // the still-parked gate.
    record = makeRecord({ status: "awaiting" });
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "gate",
          phase: "awaiting-signal",
          awaitingSignalName: "approve",
        },
      ],
    } as LogRunState;
    let resolveResume: (() => void) | undefined;
    resumeMutateAsync.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveResume = () => resolve(undefined);
        }),
    );
    const { rerender } = render(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    await waitFor(() => screen.getByText("signal-pending:false"));
    const button = screen.getByText("fire-signal") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    button.click();
    await waitFor(() => screen.getByText("signal-pending:true"));
    expect(
      (screen.getByText("fire-signal") as HTMLButtonElement).disabled,
    ).toBe(true);
    // Shared live "Working…" indicator is present during the latch.
    screen.getByText("Working…");

    // POST resolves — signal delivered — but the run is still on the same gate.
    await act(async () => {
      resolveResume?.();
      await Promise.resolve();
    });
    // Latch must remain: disabled + pending, no premature re-enable.
    expect(screen.getByText("signal-pending:true")).toBeTruthy();
    expect(
      (screen.getByText("fire-signal") as HTMLButtonElement).disabled,
    ).toBe(true);

    // The run now advances past the gate: our signal leaves the awaiting set.
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 2,
      steps: [
        { stepId: "gate", phase: "completed" },
        { stepId: "next", phase: "in-flight" },
      ],
    } as LogRunState;
    rerender(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
    );
    await waitFor(() => screen.getByText("signal-pending:false"));
    expect(
      (screen.getByText("fire-signal") as HTMLButtonElement).disabled,
    ).toBe(false);
    // Indicator gone once the gate advanced.
    expect(screen.queryByText("Working…")).toBeNull();
  });

  it("re-enables when a NON-FIRST concurrent gate is signalled and only that gate advances (wrong-step-key regression)", async () => {
    // Two gates awaiting concurrently. The user signals gateB (the second, whose
    // signal is "approve"). Only gateB completes; gateA stays parked. Keying the
    // latch on the FIRST active step would stick the button disabled forever
    // because gateA is still awaiting — keying on the submitted signal clears it.
    record = makeRecord({ status: "awaiting" });
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "gateA",
          phase: "awaiting-signal",
          awaitingSignalName: "hold",
        },
        {
          stepId: "gateB",
          phase: "awaiting-signal",
          awaitingSignalName: "approve",
        },
      ],
    } as LogRunState;
    const { rerender } = render(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    await waitFor(() => screen.getByText("signal-pending:false"));
    screen.getByText("fire-signal").click();
    await waitFor(() => screen.getByText("signal-pending:true"));

    // gateB advances; gateA (the FIRST active step) stays awaiting.
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 2,
      steps: [
        {
          stepId: "gateA",
          phase: "awaiting-signal",
          awaitingSignalName: "hold",
        },
        { stepId: "gateB", phase: "completed" },
      ],
    } as LogRunState;
    rerender(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
    );

    await waitFor(() => screen.getByText("signal-pending:false"));
    expect(
      (screen.getByText("fire-signal") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("re-enables when a concurrent gate with the same signal name is still awaiting", async () => {
    record = makeRecord({ status: "awaiting" });
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "gateA",
          phase: "awaiting-signal",
          awaitingSignalName: "approve",
        },
        {
          stepId: "gateB",
          phase: "awaiting-signal",
          awaitingSignalName: "approve",
        },
      ],
    } as LogRunState;
    const { rerender } = render(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    await waitFor(() => screen.getByText("signal-pending:false"));
    screen.getByText("fire-signal").click();
    await waitFor(() => screen.getByText("signal-pending:true"));

    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 2,
      steps: [
        { stepId: "gateA", phase: "completed" },
        {
          stepId: "gateB",
          phase: "awaiting-signal",
          awaitingSignalName: "approve",
        },
      ],
    } as LogRunState;
    rerender(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
    );

    await waitFor(() => screen.getByText("signal-pending:false"));
    expect(
      (screen.getByText("fire-signal") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("clears the latch when the same-stepId gate is consumed even if the step later re-awaits", async () => {
    // A map/loop step re-awaits under the same stepId. The latch must clear the
    // moment our signal is consumed (leaves the awaiting set) — it must not stay
    // stuck because the same stepId is present again.
    record = makeRecord({ status: "awaiting" });
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "loop",
          phase: "awaiting-signal",
          awaitingSignalName: "approve",
        },
      ],
    } as LogRunState;
    const { rerender } = render(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    await waitFor(() => screen.getByText("signal-pending:false"));
    screen.getByText("fire-signal").click();
    await waitFor(() => screen.getByText("signal-pending:true"));

    // The signal is consumed: same stepId, no longer awaiting our signal.
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 2,
      steps: [{ stepId: "loop", phase: "in-flight" }],
    } as LogRunState;
    rerender(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
    );
    await waitFor(() => screen.getByText("signal-pending:false"));
    expect(
      (screen.getByText("fire-signal") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("does not release the latch on a transient poll gap where the log momentarily reads undefined", async () => {
    record = makeRecord({ status: "awaiting" });
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "gate",
          phase: "awaiting-signal",
          awaitingSignalName: "approve",
        },
      ],
    } as LogRunState;
    const { rerender } = render(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    await waitFor(() => screen.getByText("signal-pending:false"));
    screen.getByText("fire-signal").click();
    await waitFor(() => screen.getByText("signal-pending:true"));

    // Poll gap: the log query momentarily has no data. The latch must hold.
    logStateData = undefined;
    rerender(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText("signal-pending:true")).toBeTruthy();
    expect(
      (screen.getByText("fire-signal") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("clears the pending latch on resume error so the user can retry", async () => {
    record = makeRecord({ status: "awaiting" });
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "gate",
          phase: "awaiting-signal",
          awaitingSignalName: "approve",
        },
      ],
    } as LogRunState;
    resumeMutateAsync.mockImplementation(async () => {
      throw new Error("resume failed");
    });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("signal-pending:false"));

    screen.getByText("fire-signal").click();
    // The error releases the latch even though the gate never advanced.
    await waitFor(() => screen.getByText("signal-pending:false"));
    expect(
      (screen.getByText("fire-signal") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText("Working…")).toBeNull();
    expect(resumeMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("shows a transient redeploying banner while a resume auto-retries the deploy window", async () => {
    record = makeRecord({ status: "awaiting" });
    logStateData = {
      runId: "wfr_1",
      phase: "running",
      lastSeq: 1,
      steps: [
        {
          stepId: "gate",
          phase: "awaiting-signal",
          awaitingSignalName: "approve",
        },
      ],
    } as LogRunState;
    let resolveResume: (() => void) | undefined;
    resumeMutateAsync.mockImplementation(
      (vars?: { onRedeploying?: () => void }) => {
        vars?.onRedeploying?.();
        return new Promise<undefined>((resolve) => {
          resolveResume = () => resolve(undefined);
        });
      },
    );
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("fire-signal"));
    screen.getByText("fire-signal").click();

    await waitFor(() => screen.getByText("Finishing an update — retrying…"));

    // Flush the resume resolution (its `.finally` clears the redeploying flag)
    // inside act so the state update applies deterministically, not on an
    // unbatched microtask that races the assertion.
    await act(async () => {
      resolveResume?.();
      await Promise.resolve();
    });
    expect(screen.queryByText("Finishing an update — retrying…")).toBeNull();
  });

  it("onSignal is a no-op once the run is terminal", async () => {
    record = makeRecord({
      status: "completed",
    });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("fire-signal"));
    screen.getByText("fire-signal").click();
    expect(resumeMutateAsync).not.toHaveBeenCalled();
  });

  it("renders a version badge when the matching deployment has meta", async () => {
    record = makeRecord({
      kind: "with-panel",
      status: "completed",
      deploymentId: "ses_dep1",
    });
    deployments = [
      {
        deploymentId: "ses_dep1",
        kind: "with-panel",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        meta: {
          version: "1.2.3",
          sha: "abc1234",
          deployedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ];
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() =>
      screen.getByRole("button", {
        name: /Workflow version: v1\.2\.3 · abc1234/i,
      }),
    );
  });

  it("resolves the exact deployment that produced the run, not the newest of the kind", async () => {
    // Two live deployments of the same kind; the run was produced by the older
    // one. The badge must show the run's actual version, not the newest deploy.
    record = makeRecord({
      kind: "with-panel",
      status: "completed",
      deploymentId: "ses_old",
    });
    deployments = [
      {
        deploymentId: "ses_new",
        kind: "with-panel",
        status: "running",
        createdAt: "2026-02-01T00:00:00.000Z",
        meta: {
          version: "2.0.0",
          sha: "new0000",
          deployedAt: "2026-02-01T00:00:00.000Z",
        },
      },
      {
        deploymentId: "ses_old",
        kind: "with-panel",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        meta: {
          version: "1.2.3",
          sha: "abc1234",
          deployedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ];
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() =>
      screen.getByRole("button", {
        name: /Workflow version: v1\.2\.3 · abc1234/i,
      }),
    );
    expect(screen.queryByRole("button", { name: /v2\.0\.0/i })).toBeNull();
  });

  it("renders the badge from the run record when the kind's deployment is absent from the grant-filtered catalog", async () => {
    // An owner disabled the kind, so the member-facing deployments list omits
    // it. The badge must survive: it is audit info for a run that already ran,
    // sourced from the record's own version meta, not the gated catalog list.
    record = makeRecord({
      kind: "with-panel",
      status: "completed",
      deploymentId: "ses_dep1",
      meta: {
        version: "3",
        sha: "a1b2c3d",
        deployedAt: "2026-05-01T00:00:00.000Z",
      },
    });
    deployments = [];
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() =>
      screen.getByRole("button", {
        name: /Workflow version: v3 · a1b2c3d/i,
      }),
    );
  });

  it("prefers the record's own meta over a stale catalog entry for the same deployment", async () => {
    record = makeRecord({
      kind: "with-panel",
      status: "completed",
      deploymentId: "ses_dep1",
      meta: {
        version: "3",
        sha: "a1b2c3d",
        deployedAt: "2026-05-01T00:00:00.000Z",
      },
    });
    deployments = [
      {
        deploymentId: "ses_dep1",
        kind: "with-panel",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        meta: {
          version: "1.2.3",
          sha: "abc1234",
          deployedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ];
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() =>
      screen.getByRole("button", {
        name: /Workflow version: v3 · a1b2c3d/i,
      }),
    );
    expect(screen.queryByRole("button", { name: /v1\.2\.3/i })).toBeNull();
  });

  it("opens the version popover via keyboard and shows version, sha and deployed time", async () => {
    record = makeRecord({
      kind: "with-panel",
      status: "completed",
      deploymentId: "ses_dep1",
    });
    deployments = [
      {
        deploymentId: "ses_dep1",
        kind: "with-panel",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        meta: {
          version: "1.2.3",
          sha: "abc1234",
          deployedAt: "2026-03-04T05:06:07.000Z",
        },
      },
    ];
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() =>
      screen.getByRole("button", {
        name: /Workflow version: v1\.2\.3 · abc1234/i,
      }),
    );
    // Wait for the Panel to settle so the badge node isn't swapped mid-render.
    await screen.findByText("custom-panel-for-wfr_1");
    expect(screen.queryByRole("dialog")).toBeNull();

    const trigger = screen.getByRole("button", {
      name: /Workflow version: v1\.2\.3 · abc1234/i,
    });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await waitFor(() => screen.getByRole("dialog"));
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("1.2.3");
    expect(dialog.textContent).toContain("abc1234");
    // Locale/timezone-independent UTC formatting, not toLocaleString.
    expect(dialog.textContent).toContain("2026-03-04 05:06 UTC");

    // Focus trap: Tab keeps focus on the dialog container, not the Panel behind.
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(dialog);
  });

  it("Escape closes the popover and returns focus to the trigger", async () => {
    record = makeRecord({
      kind: "with-panel",
      status: "completed",
      deploymentId: "ses_dep1",
    });
    deployments = [
      {
        deploymentId: "ses_dep1",
        kind: "with-panel",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        meta: {
          version: "1.2.3",
          sha: "abc1234",
          deployedAt: "2026-03-04T05:06:07.000Z",
        },
      },
    ];
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await screen.findByText("custom-panel-for-wfr_1");
    const trigger = screen.getByRole("button", { name: /Workflow version/i });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => screen.getByRole("dialog"));

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("does not render a version badge when deployment has no meta", async () => {
    record = makeRecord({
      kind: "with-panel",
      status: "running",
      deploymentId: "ses_dep2",
    });
    deployments = [
      {
        deploymentId: "ses_dep2",
        kind: "with-panel",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        meta: null,
      },
    ];
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("custom-panel-for-wfr_1"));
    expect(
      screen.queryByRole("button", { name: /Workflow version/i }),
    ).toBeNull();
  });

  it("does not render a version badge when the run has no deploymentId", async () => {
    record = makeRecord({ kind: "with-panel", status: "running" });
    deployments = [
      {
        deploymentId: "ses_dep1",
        kind: "with-panel",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        meta: {
          version: "1.2.3",
          sha: "abc1234",
          deployedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ];
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("custom-panel-for-wfr_1"));
    expect(
      screen.queryByRole("button", { name: /Workflow version/i }),
    ).toBeNull();
  });

  it("renders a live animated Starting… state for a provisioning run, never the frozen panel (CL-2755)", async () => {
    // The run's per-run deployment is still cold-starting: no deployment, no log.
    record = makeRecord({ kind: "with-panel", status: "provisioning" });
    logStateData = undefined;
    logStateError = true;
    const { container } = render(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    const indicator = await waitFor(() =>
      screen.getByTestId("workflow-starting-indicator"),
    );
    // Motion is the hard requirement — the shared PulsingRing overlay (CL-4394,
    // via StatusDot) must be present, matching the dock's "starting" dot.
    expect(container.querySelector(".bg-blue\\/60")).not.toBeNull();
    // CL-2786: honest present-progress copy from the shared runStartLabel.
    expect(indicator.textContent).toContain("Preparing your workflow…");
    // The workflow's own panel is NOT rendered while provisioning.
    expect(screen.queryByText("custom-panel-for-wfr_1")).toBeNull();
  });

  it("transitions Starting → custom Panel with NO generic-shell flash while the Panel module is still loading (CL-2755 handoff flicker)", async () => {
    // The Panel module is held PENDING (slow-panel, reset to null by afterEach)
    // so the running flip lands while `uiModule` is still loading — the exact
    // window the flicker fix covers.
    record = makeRecord({ kind: "slow-panel", status: "provisioning" });
    logStateData = undefined;
    logStateError = true;
    const { rerender } = render(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    await waitFor(() => screen.getByTestId("workflow-starting-indicator"));

    // The projection advances the run to running while the Panel module has NOT
    // resolved yet.
    record = makeRecord({ kind: "slow-panel", status: "running" });
    logStateData = { runId: "wfr_1", phase: "running", lastSeq: 1, steps: [] };
    logStateError = false;
    rerender(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
    );

    // While the module loads, the animated loading state stays up — the generic
    // WorkflowRunBlocks shell ("Workflow run" header) must NEVER flash in between.
    await waitFor(() => screen.getByTestId("workflow-starting-indicator"));
    expect(screen.queryByText("Workflow run")).toBeNull();
    expect(screen.queryByText("custom-panel-for-wfr_1")).toBeNull();

    // Resolve the module → straight to the custom Panel, no shell in between.
    resolveSlowPanel?.();
    await waitFor(() => screen.getByText("custom-panel-for-wfr_1"));
    expect(screen.queryByTestId("workflow-starting-indicator")).toBeNull();
    expect(screen.queryByText("Workflow run")).toBeNull();
  });

  it("keeps ONE continuously-mounted spinner node across provisioning→loading-workflow (CL-2786 — no remount, no rotation reset)", async () => {
    // The provisioning frame and the module-loading frame share one stable
    // AnimatePresence key ("starting"), so the spinner is the SAME DOM node
    // before and after the transition — never unmounted and re-mounted (which
    // would restart the CSS animate-spin from 0° and flash a blank beat). Only
    // the label text swaps.
    record = makeRecord({ kind: "slow-panel", status: "provisioning" });
    logStateData = undefined;
    logStateError = true;
    const { rerender } = render(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    const spinnerBefore = await waitFor(() =>
      screen.getByTestId("workflow-starting-spinner"),
    );
    const indicatorBefore = screen.getByTestId("workflow-starting-indicator");
    expect(indicatorBefore.textContent).toContain("Preparing your workflow…");

    // Run flips provisioning→running while the Panel module is STILL pending —
    // the exact provisioning→loading-workflow boundary this fix covers.
    record = makeRecord({ kind: "slow-panel", status: "running" });
    logStateData = { runId: "wfr_1", phase: "running", lastSeq: 1, steps: [] };
    logStateError = false;
    rerender(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
    );

    // The label swapped to the module-loading copy…
    await waitFor(() =>
      expect(
        screen.getByTestId("workflow-starting-indicator").textContent,
      ).toContain("Loading workflow…"),
    );
    // …but it is the SAME spinner node — proving continuity (no exit/enter, no
    // rotation reset). Node identity is preserved only when the key is stable.
    expect(screen.getByTestId("workflow-starting-spinner")).toBe(spinnerBefore);
    resolveSlowPanel?.();
  });

  it("keeps the Starting… indicator up while provisioning and the log is still pending (CL-2785)", async () => {
    // record projection reports provisioning; the fast log has NOT started yet
    // (phase pending). The coarse gate must still show the animated indicator.
    record = makeRecord({ kind: "with-panel", status: "provisioning" });
    logStateData = { runId: "wfr_1", phase: "pending", lastSeq: 0, steps: [] };
    logStateError = false;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByTestId("workflow-starting-indicator"));
    expect(screen.queryByText("custom-panel-for-wfr_1")).toBeNull();
  });

  it("lifts the Starting… gate the moment the fast log reads running, even while the record still says provisioning (CL-2785, the ~2s win)", async () => {
    // The record projection lags at provisioning, but the SSE log has already
    // flipped to running. `started` must derive from the log and advance the pane
    // to the live view immediately instead of dwelling on the coarse gate.
    record = makeRecord({ kind: "with-panel", status: "provisioning" });
    logStateData = { runId: "wfr_1", phase: "running", lastSeq: 1, steps: [] };
    logStateError = false;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("custom-panel-for-wfr_1"));
    expect(screen.queryByTestId("workflow-starting-indicator")).toBeNull();
  });

  it("falls through to the failure UI when a run fails during provisioning and never went live (CL-2785 regression — the provisioning guard is load-bearing)", async () => {
    // A run that flipped provisioning→failed WITHOUT ever reaching running: the
    // log never materialized (started = false). A naive `if (!started)` gate that
    // drops the `record.status === "provisioning"` guard would STICK on the
    // Starting… indicator here. The `provisioning && !started` form stops matching
    // once status is failed, so the pane must render the legible failure UI.
    record = makeRecord({ kind: "no-panel", status: "failed" });
    logStateData = undefined;
    logStateError = true;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() =>
      screen.getByText(/this run failed\. start a new run to try again\./i),
    );
    expect(screen.queryByTestId("workflow-starting-indicator")).toBeNull();
  });

  it("passes connected=true to the Panel for a live running run and connected=false once terminal (CL-2785)", async () => {
    record = makeRecord({ kind: "with-panel", status: "running" });
    logStateData = { runId: "wfr_1", phase: "running", lastSeq: 1, steps: [] };
    const { rerender } = render(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
      { wrapper },
    );
    await waitFor(() => screen.getByText("connected:true"));

    record = makeRecord({ kind: "with-panel", status: "completed" });
    rerender(
      <WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />,
    );
    await waitFor(() => screen.getByText("connected:false"));
  });
});
