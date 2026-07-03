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

type ApiCall = { method: string; path: string };

let apiCalls: ApiCall[] = [];
let records: unknown = [];
let statesByRunId: Record<string, unknown> = {};

async function fakeApi(method: string, path: string): Promise<unknown> {
  apiCalls.push({ method, path });
  if (path.includes("originConversationId=")) return records;
  const stateMatch = /\/workflow-exec\/runs\/([^/]+)\/state/.exec(path);
  if (stateMatch?.[1] !== undefined) {
    const state = statesByRunId[stateMatch[1]];
    if (state === undefined) throw new Error(`no state for ${stateMatch[1]}`);
    return state;
  }
  throw new Error(`unexpected api call: ${method} ${path}`);
}

function listRow(
  runId: string,
  status: "running" | "awaiting" | "completed" | "failed",
  kind = "ab-compare-hitl",
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
  records = [];
  statesByRunId = {};
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

  it("is hidden on fresh load when every run is already terminal", async () => {
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
      listRow("run_gate", "awaiting", "pain-point-collateral"),
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
    expect(cards[0]?.textContent).toContain("pain-point-collateral");
    expect(cards[0]?.textContent).toContain("Needs you");
    expect(cards[1]?.textContent).toContain("ab-compare-hitl");
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

    const card = await waitFor(() =>
      screen.getByTestId("workflow-dock-card"),
    );
    // Finished runs collapse to a one-line summary by default; expand to see blocks.
    fireEvent.click(
      card.querySelector("[data-testid=dock-card-toggle]") as HTMLElement,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/rate-limiting requests right now/),
      ).toBeTruthy();
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
    const expand = screen.getByLabelText("Expand workflow dock");
    expect(expand.textContent).toContain("1");
    expect(screen.getByTestId("dock-rail-dot")).toBeTruthy();

    // A background refetch re-render must not reopen the dock.
    await queryClient.refetchQueries();
    expect(screen.queryByTestId("workflow-dock-card")).toBeNull();

    fireEvent.click(screen.getByLabelText("Expand workflow dock"));
    await waitFor(() => screen.getByTestId("workflow-dock-card"));
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
});
