/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, it, expect, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowPanelProps } from "@workbench/ui";
import * as workflowHooks from "../hooks/use-workflow";
import type { LogRunState, RunRecord } from "../lib/run-state-adapter";

function CustomPanel({
  deploymentId,
  stepOutputs,
  signalPending,
  skills,
  onSignal,
}: WorkflowPanelProps) {
  return (
    <div>
      <span>custom-panel-for-{deploymentId}</span>
      <span>signal-pending:{String(signalPending)}</span>
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
      <button onClick={() => onSignal("approve", { ok: true })}>
        fire-signal
      </button>
    </div>
  );
}

mock.module("../lib/workflow-ui", () => ({
  loadWorkflowUI: async (kind: string) => {
    if (kind === "with-panel") return { Panel: CustomPanel };
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

const resumeMutateAsync = mock(async () => undefined);

mock.module("../hooks/use-workflow", () => ({
  ...workflowHooks,
  useWorkflowRecord: () => ({ data: record ?? undefined, isLoading, isError }),
  useWorkflowRunState: () => ({ data: logStateData, isError: logStateError }),
  useWorkflowStepOutputs: () => ({ data: stepOutputsData }),
  useResumeWorkflow: () => ({
    mutateAsync: resumeMutateAsync,
    isPending: false,
  }),
  useWorkflowCredentials: () => ({ data: [] }),
  useWorkflowDeployments: () => ({ data: deployments }),
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
    resumeMutateAsync.mockReset();
    resumeMutateAsync.mockImplementation(async () => undefined);
  });

  it("renders the workflow kind own Panel when its module exports one", async () => {
    record = makeRecord({});
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("custom-panel-for-wfr_1"));
  });

  it("falls back to RunConsole when the module has no Panel", async () => {
    record = makeRecord({ kind: "no-panel" });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("Workflow run"));
    expect(screen.queryByText("custom-panel-for-wfr_1")).toBeNull();
  });

  it("falls back to a legible run state when the log query errors, instead of hanging on Loading run…", async () => {
    // Repro of Finding B: a legacy run (no deploymentId) 400s on /state, so the
    // log query errors and logState is undefined. The pane used to sit on
    // "Loading run…" forever. It must fall back to the record-derived run-level
    // state and render the terminal failure copy.
    record = makeRecord({ kind: "no-panel", status: "failed" });
    logStateData = undefined;
    logStateError = true;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("Workflow run"));
    // Legible terminal copy, not a permanent loading placeholder.
    screen.getByText(/this run failed\. start a new run to try again\./i);
    expect(screen.queryByText("Loading run…")).toBeNull();
  });

  it("keeps showing Loading run… while the log is genuinely still loading (no error, deployment present)", () => {
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
    screen.getByText("Loading run…");
  });

  it("shows the loading placeholder while the record query is loading", () => {
    isLoading = true;
    record = null;
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    screen.getByText("Loading run…");
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

  it("onSignal resumes when the run is awaiting", async () => {
    record = makeRecord({ status: "awaiting" });
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("fire-signal"));
    screen.getByText("fire-signal").click();
    await waitFor(() => expect(resumeMutateAsync).toHaveBeenCalledTimes(1));
    expect(resumeMutateAsync).toHaveBeenCalledWith({
      signalName: "approve",
      payload: { ok: true },
    });
  });

  it("passes signalPending to the Panel and raises it while the resume is in flight", async () => {
    record = makeRecord({ status: "awaiting" });
    let resolveResume: (() => void) | undefined;
    resumeMutateAsync.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveResume = () => resolve(undefined);
        }),
    );
    render(<WorkflowRunPane deploymentId="wfr_1" onClose={() => undefined} />, {
      wrapper,
    });
    await waitFor(() => screen.getByText("signal-pending:false"));

    screen.getByText("fire-signal").click();
    await waitFor(() => screen.getByText("signal-pending:true"));

    resolveResume?.();
    await waitFor(() => screen.getByText("signal-pending:false"));
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
});
