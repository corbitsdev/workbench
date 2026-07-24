import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import * as apiActual from "../lib/api";
import { WorkflowDock } from "./WorkflowDock";

type ApiCall = { method: string; path: string; body?: unknown };

let apiCalls: ApiCall[] = [];
let failStopRuns = false;
let records: unknown = [];
let statesByRunId: Record<string, unknown> = {};

async function fakeApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  apiCalls.push({ method, path, body });
  if (path.includes("originConversationId=")) return records;
  const stateMatch = /\/workflow-exec\/runs\/([^/]+)\/state/.exec(path);
  if (stateMatch?.[1] !== undefined) {
    const state = statesByRunId[stateMatch[1]];
    if (state === undefined) throw new Error(`no state for ${stateMatch[1]}`);
    return state;
  }
  const resumeMatch = /\/workflow-exec\/records\/([^/]+)\/resume/.exec(path);
  if (resumeMatch?.[1] !== undefined) {
    return {
      runId: resumeMatch[1],
      kind: "smoke-test",
      status: "running",
    };
  }
  const stopMatch = /\/workflow-exec\/records\/([^/]+)\/stop/.exec(path);
  if (stopMatch?.[1] !== undefined) {
    if (failStopRuns) throw new Error("stop failed");
    return { stopped: true };
  }
  throw new Error(`unexpected api call: ${method} ${path}`);
}

function listRow(
  runId: string,
  status:
    | "provisioning"
    | "running"
    | "awaiting"
    | "completed"
    | "failed"
    | "stopped",
  kind = "ab-compare-quality",
) {
  return {
    runId,
    kind,
    status,
    createdAt: "2026-07-02T10:00:00.000Z",
    originConversationId: "conv-1",
  };
}

function logState(
  runId: string,
  phase: string,
  steps: {
    stepId: string;
    phase: string;
    lastError?: { message: string };
    awaitingSignalName?: string;
  }[],
) {
  return {
    runId,
    phase,
    lastSeq: steps.length,
    steps: steps.map((s) => ({
      stepType: "deterministic",
      currentAttempt: 1,
      ...s,
    })),
  };
}

let queryClient: QueryClient;

function renderDock(conversationId: string | null = "conv-1") {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkflowDock conversationId={conversationId} tenantId={null} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiCalls = [];
  failStopRuns = false;
  records = [];
  statesByRunId = {};
  localStorage.clear();
  sessionStorage.clear();
  mock.module("../lib/api", () => ({ ...apiActual, api: fakeApi }));
});

afterEach(() => {
  queryClient.clear();
  cleanup();
});

describe("WorkflowDock", () => {
  it("renders nothing and issues no query without a conversation id", async () => {
    const { container } = renderDock(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector("aside")).toBeNull();
    expect(apiCalls).toHaveLength(0);
  });

  it("is hidden entirely when the conversation has zero runs", async () => {
    records = [];
    const { container } = renderDock();
    await waitFor(() => expect(apiCalls.length).toBeGreaterThan(0));
    expect(container.querySelector("aside")).toBeNull();
  });

  it("is hidden on fresh load when every run has already completed", async () => {
    records = [listRow("run_done", "completed")];
    statesByRunId["run_done"] = logState("run_done", "completed", [
      { stepId: "fetch", phase: "completed" },
    ]);
    const { container } = renderDock();
    await waitFor(() => expect(apiCalls.length).toBeGreaterThan(0));
    expect(container.querySelector("aside")).toBeNull();
  });

  it("renders a card per run, sorted by attention, with progress states from the log", async () => {
    records = [
      listRow("run_running", "running"),
      listRow("run_gate", "awaiting", "smoke-test"),
    ];
    statesByRunId["run_running"] = logState("run_running", "running", [
      { stepId: "fetch_sources", phase: "completed" },
      { stepId: "draft", phase: "in-flight" },
    ]);
    statesByRunId["run_gate"] = logState("run_gate", "running", [
      {
        stepId: "review-gate",
        phase: "awaiting-signal",
        awaitingSignalName: "approve",
      },
    ]);
    renderDock();

    const cards = await waitFor(() => {
      const found = screen.getAllByTestId("workflow-dock-card");
      expect(found).toHaveLength(2);
      return found;
    });

    // Attention sort: the awaiting (needs-you) run leads.
    expect(cards[0]?.textContent).toContain("smoke-test");
    expect(cards[0]?.textContent).toContain("Needs you");
    expect(cards[1]?.textContent).toContain("ab-compare-quality");
    expect(cards[1]?.textContent).toContain("Running");

    // Progress states derived from log step phases.
    await waitFor(() => {
      const gateSteps = cards[0]?.querySelectorAll("[data-state]") ?? [];
      expect([...gateSteps].map((s) => s.getAttribute("data-state"))).toEqual([
        "awaiting",
      ]);
      const runningSteps = cards[1]?.querySelectorAll("[data-state]") ?? [];
      expect(
        [...runningSteps].map((s) => s.getAttribute("data-state")),
      ).toEqual(["done", "running"]);
    });
    expect(screen.getByText("fetch sources")).toBeTruthy();
    expect(screen.getByText("awaiting input")).toBeTruthy();
  });

  it("shows the sanitized error, never the raw text, for a failed run", async () => {
    records = [listRow("run_failed", "failed")];
    statesByRunId["run_failed"] = logState("run_failed", "failed", [
      { stepId: "fetch", phase: "completed" },
      {
        stepId: "enrich",
        phase: "failed",
        lastError: { message: "Exa API error: 429 too many requests" },
      },
    ]);
    renderDock();

    const card = await waitFor(() => screen.getByTestId("workflow-dock-card"));
    // Finished runs collapse to a one-line summary by default; expand to see blocks.
    fireEvent.click(
      card.querySelector("[data-testid=dock-card-toggle]") as HTMLElement,
    );
    await waitFor(() => {
      expect(screen.getByText(/rate-limiting requests right now/)).toBeTruthy();
    });
    expect(screen.queryByText(/API error/)).toBeNull();
    expect(card.textContent).toContain("Failed");
  });

  it("collapses to a rail with count and state dots, and the collapse persists across refreshes", async () => {
    records = [listRow("run_running", "running")];
    statesByRunId["run_running"] = logState("run_running", "running", [
      { stepId: "draft", phase: "in-flight" },
    ]);
    renderDock();
    await waitFor(() => screen.getByTestId("workflow-dock-card"));

    fireEvent.click(screen.getByLabelText("Collapse workflow dock"));
    expect(screen.queryByTestId("workflow-dock-card")).toBeNull();
    // The rail's expand label carries the per-state counts — the text
    // alternative to its color-only dots.
    const expand = screen.getByLabelText("Expand workflows: 1 running");
    expect(expand.textContent).toContain("1");
    const dot = screen.getByTestId("dock-rail-dot");
    expect(dot.textContent).toContain("ab-compare-quality: Running");

    // A background refetch re-render must not reopen the dock.
    await queryClient.refetchQueries();
    expect(screen.queryByTestId("workflow-dock-card")).toBeNull();

    fireEvent.click(screen.getByLabelText("Expand workflows: 1 running"));
    await waitFor(() => screen.getByTestId("workflow-dock-card"));
  });

  it("gives a running rail dot the shared PulsingRing motion, and a completed one no motion (CL-4416)", async () => {
    records = [
      listRow("run_running", "running"),
      listRow("run_done", "completed"),
    ];
    statesByRunId["run_running"] = logState("run_running", "running", [
      { stepId: "draft", phase: "in-flight" },
    ]);
    renderDock();
    await waitFor(() => screen.getAllByTestId("workflow-dock-card"));

    fireEvent.click(screen.getByLabelText("Collapse workflow dock"));
    const dots = screen.getAllByTestId("dock-rail-dot");
    const runningDot = dots.find((d) =>
      d.textContent?.includes("ab-compare-quality: Running"),
    );
    const doneDot = dots.find((d) => d.textContent?.includes(": Done"));
    // PulsingRing (CL-4394) renders its own animated overlay span colored
    // `${color}/60`; a raw `animate-pulse` dot would not have this element.
    expect(runningDot?.querySelector(".bg-blue\\/60")).not.toBeNull();
    expect(doneDot?.querySelector(".bg-green\\/60")).toBeNull();
  });

  it("gives a provisioning rail dot the same live PulsingRing motion as running, never a frozen dot (CL-2755)", async () => {
    records = [listRow("run_starting", "provisioning", "smoke-test")];
    renderDock();
    await waitFor(() => screen.getByTestId("workflow-dock-card"));

    fireEvent.click(screen.getByLabelText("Collapse workflow dock"));
    const dot = screen.getByTestId("dock-rail-dot");
    expect(dot.textContent).toContain("smoke-test: Starting");
    expect(dot.querySelector(".bg-blue\\/60")).not.toBeNull();
  });

  it("persists the collapsed state per conversation across remounts", async () => {
    records = [listRow("run_running", "running")];
    statesByRunId["run_running"] = logState("run_running", "running", [
      { stepId: "draft", phase: "in-flight" },
    ]);
    const first = renderDock();
    await waitFor(() => screen.getByTestId("workflow-dock-card"));
    fireEvent.click(screen.getByLabelText("Collapse workflow dock"));
    first.unmount();
    queryClient.clear();

    renderDock();
    await waitFor(() => screen.getByLabelText("Expand workflows: 1 running"));
    expect(screen.queryByTestId("workflow-dock-card")).toBeNull();
  });

  it("shows the dock on fresh load when a run has failed", async () => {
    records = [listRow("run_failed", "failed")];
    statesByRunId["run_failed"] = logState("run_failed", "failed", [
      { stepId: "fetch", phase: "failed", lastError: { message: "x" } },
    ]);
    const { container } = renderDock();
    await waitFor(() => screen.getByTestId("workflow-dock-card"));
    expect(container.querySelector("aside")).toBeTruthy();
  });

  it("dismissing a failed run hides it, and the dock stays hidden for the session", async () => {
    records = [listRow("run_failed", "failed")];
    statesByRunId["run_failed"] = logState("run_failed", "failed", [
      { stepId: "fetch", phase: "failed", lastError: { message: "x" } },
    ]);
    const first = renderDock();
    await waitFor(() => screen.getByTestId("workflow-dock-card"));
    fireEvent.click(screen.getByLabelText("Dismiss ab-compare-quality"));
    expect(screen.queryByTestId("workflow-dock-card")).toBeNull();
    first.unmount();
    queryClient.clear();

    // Same session, fresh mount: the dismissal persists (sessionStorage).
    const before = apiCalls.length;
    const { container } = renderDock();
    await waitFor(() => expect(apiCalls.length).toBeGreaterThan(before));
    expect(container.querySelector("aside")).toBeNull();
  });

  it("resumes the gated run with its recovered signalName when the gate button is used (CL-2681)", async () => {
    records = [listRow("run_gate", "awaiting", "smoke-test")];
    statesByRunId["run_gate"] = logState("run_gate", "running", [
      {
        stepId: "review-gate",
        phase: "awaiting-signal",
        awaitingSignalName: "approve-draft",
      },
    ]);
    renderDock();

    const button = await waitFor(() =>
      screen.getByRole("button", { name: "Continue" }),
    );
    fireEvent.click(button);

    await waitFor(() => {
      const resume = apiCalls.find((c) => c.path.includes("/resume"));
      expect(resume).toBeDefined();
    });
    const resume = apiCalls.find((c) => c.path.includes("/resume"))!;
    expect(resume.method).toBe("POST");
    expect(resume.path).toContain("/workflow-exec/records/run_gate/resume");
    expect(resume.body).toMatchObject({ signalName: "approve-draft" });
  });

  it("renders the migrated A/B preset decision as a winner choice and resumes with the structured ranking payload (CL-3074)", async () => {
    const inline = (value: unknown) => `inline:${JSON.stringify(value)}`;
    records = [listRow("run_ab", "awaiting", "ab-compare-quality")];
    statesByRunId["run_ab"] = {
      runId: "run_ab",
      phase: "running",
      lastSeq: 3,
      steps: [
        {
          stepId: "config",
          phase: "completed",
          stepType: "human",
          currentAttempt: 1,
          outputRef: inline({ input: "Write a tagline." }),
        },
        {
          stepId: "exec0",
          phase: "completed",
          stepType: "inline",
          currentAttempt: 1,
          outputRef: inline({ reply: "Close deals faster." }),
        },
        {
          stepId: "exec1",
          phase: "completed",
          stepType: "inline",
          currentAttempt: 1,
          outputRef: inline({ reply: "Your team's shared brain." }),
        },
        {
          stepId: "decision",
          phase: "awaiting-signal",
          stepType: "human",
          currentAttempt: 1,
          awaitingSignalName: "ab-decision",
        },
      ],
    };
    renderDock();

    // Blind per-variant output cards render via the shared UIBlockView, and the
    // pre-decision surface reveals NO model identity (blind pick).
    const winnerButton = await waitFor(() =>
      screen.getByRole("button", { name: "Variant 2 wins" }),
    );
    // "Variant N" appears both as the output card title and the humanized
    // progress-rail label, so there are multiple matches — the point is the
    // blind label is present and no model identity leaks.
    expect(screen.getAllByText("Variant 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Variant 2").length).toBeGreaterThan(0);
    expect(screen.queryByText(/gpt-4o/)).toBeNull();
    expect(screen.queryByText(/claude-3\.5/)).toBeNull();

    // Pick Variant 2.
    fireEvent.click(winnerButton);

    await waitFor(() => {
      const resume = apiCalls.find((c) => c.path.includes("/resume"));
      expect(resume).toBeDefined();
    });
    const resume = apiCalls.find((c) => c.path.includes("/resume"))!;
    expect(resume.path).toContain("/workflow-exec/records/run_ab/resume");
    // Not an { instruction } free-text wrapper — a real ranked decision the
    // compose step reads directly, with the picked variant ranked first.
    const body = resume.body as {
      signalName: string;
      payload: { ranking: { rank: number; label: string }[] };
    };
    expect(body.signalName).toBe("ab-decision");
    expect(body.payload.ranking[0]).toEqual({ rank: 1, label: "Variant 2" });
    expect("instruction" in body.payload).toBe(false);
  });

  it("shows no gate button when the awaiting step's signalName is unrecoverable", async () => {
    records = [listRow("run_gate", "awaiting", "smoke-test")];
    statesByRunId["run_gate"] = logState("run_gate", "running", [
      { stepId: "review-gate", phase: "awaiting-signal" },
    ]);
    renderDock();
    await waitFor(() => screen.getByTestId("workflow-dock-card"));
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("renders the run-page link (surface 'dock') for a gate whose producing step's output isn't readable here yet (CL-4284)", async () => {
    records = [listRow("run_notes", "awaiting", "pain-point-collateral")];
    statesByRunId["run_notes"] = logState("run_notes", "running", [
      { stepId: "intake", phase: "in-flight" },
      {
        stepId: "note-selection",
        phase: "awaiting-signal",
        awaitingSignalName: "note-selection",
      },
    ]);
    renderDock();
    await waitFor(() => screen.getByTestId("workflow-dock-card"));
    screen.getByText("Open the run to pick a transcript");
  });

  it("names the failed step with a CLASSIFIED detail instead of a run-page link when its producing step FAILED (CL-4284)", async () => {
    records = [
      listRow("run_notes_failed", "awaiting", "pain-point-collateral"),
    ];
    statesByRunId["run_notes_failed"] = logState(
      "run_notes_failed",
      "running",
      [
        {
          stepId: "intake",
          phase: "failed",
          lastError: { message: "Granola API error: 401 Unauthorized" },
        },
        {
          stepId: "note-selection",
          phase: "awaiting-signal",
          awaitingSignalName: "note-selection",
        },
      ],
    );
    renderDock();
    await waitFor(() => screen.getByTestId("workflow-dock-card"));
    expect(screen.queryByText("Open the run to pick a transcript")).toBeNull();
    screen.getByText(/"intake" failed, so this step can't continue\./);
    // Classified, plain-language detail — never the raw provider error string.
    screen.getByText(
      "Granola declined the request (401). Check the connected Granola credential's access and try again.",
    );
    expect(screen.queryByText(/API error: 401/)).toBeNull();
  });

  it("links each card to the full run page", async () => {
    records = [listRow("run_running", "running")];
    statesByRunId["run_running"] = logState("run_running", "running", [
      { stepId: "draft", phase: "in-flight" },
    ]);
    renderDock();
    await waitFor(() => screen.getByTestId("workflow-dock-card"));
    const link = screen.getByRole("link", { name: "Open" });
    expect(link.getAttribute("href")).toBe("/workflows/run_running");
  });

  it("renders a live animated Starting… state for a provisioning run without waiting on the log (CL-2755)", async () => {
    // A provisioning run has no deployment and no log yet — the card must show a
    // moving Starting state, not the frozen "Waiting for the first step…" copy or
    // a raw log error. No state is seeded, so /state would error — the card must
    // not depend on it.
    records = [listRow("run_starting", "provisioning", "smoke-test")];
    const { container } = renderDock();

    const card = await waitFor(() => screen.getByTestId("workflow-dock-card"));
    // The status chip reads Starting.
    expect(card.textContent).toContain("Starting");
    // Motion is present (animated spinner) — the run never looks frozen.
    await waitFor(() =>
      expect(screen.getByTestId("workflow-starting-indicator")).toBeTruthy(),
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    // The frozen "waiting" copy is NOT shown for a provisioning run.
    expect(screen.queryByText("Waiting for the first step…")).toBeNull();
  });

  it("shows Stop on non-terminal cards and hides it on terminal ones (CL-3687)", async () => {
    records = [
      listRow("run_live", "running"),
      listRow("run_done", "completed"),
      listRow("run_stopped", "stopped"),
    ];
    statesByRunId["run_live"] = logState("run_live", "running", [
      { stepId: "draft", phase: "in-flight" },
    ]);
    statesByRunId["run_done"] = logState("run_done", "completed", [
      { stepId: "draft", phase: "completed" },
    ]);
    statesByRunId["run_stopped"] = logState("run_stopped", "cancelled", [
      { stepId: "draft", phase: "cancelled" },
    ]);
    renderDock();
    await waitFor(() =>
      expect(screen.getAllByTestId("workflow-dock-card").length).toBe(3),
    );
    // One Stop control for the live run only.
    expect(screen.getAllByTestId("dock-stop")).toHaveLength(1);
    expect(screen.getByLabelText("Stop ab-compare-quality run")).toBeTruthy();
  });

  it("two-step confirm POSTs stop and does not fire on the first click (CL-3687)", async () => {
    records = [listRow("run_live", "running")];
    statesByRunId["run_live"] = logState("run_live", "running", [
      { stepId: "draft", phase: "in-flight" },
    ]);
    renderDock();
    await waitFor(() => screen.getByTestId("dock-stop"));

    fireEvent.click(screen.getByTestId("dock-stop"));
    expect(apiCalls.some((c) => c.path.includes("/stop"))).toBe(false);

    fireEvent.click(screen.getByTestId("dock-stop-confirm"));
    await waitFor(() =>
      expect(
        apiCalls.some(
          (c) =>
            c.method === "POST" &&
            c.path.includes("/workflow-exec/records/run_live/stop"),
        ),
      ).toBe(true),
    );
  });

  it("surfaces a legible error when the stop request fails (CL-3687)", async () => {
    failStopRuns = true;
    records = [listRow("run_live", "running")];
    statesByRunId["run_live"] = logState("run_live", "running", [
      { stepId: "draft", phase: "in-flight" },
    ]);
    renderDock();
    await waitFor(() => screen.getByTestId("dock-stop"));

    fireEvent.click(screen.getByTestId("dock-stop"));
    fireEvent.click(screen.getByTestId("dock-stop-confirm"));

    await waitFor(() => screen.getByTestId("dock-stop-error"));
    expect(screen.getByText("Couldn't stop this run. Try again.")).toBeTruthy();
    // Confirm stays available so the user can retry the stop.
    expect(screen.getByTestId("dock-stop-confirm")).toBeTruthy();
  });
});
