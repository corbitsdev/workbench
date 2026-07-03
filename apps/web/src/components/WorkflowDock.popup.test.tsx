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
// Records keyed by originConversationId — the fake api serves only the runs
// stamped for the requested conversation, mirroring the server-side filter.
let recordsByConversation: Record<string, unknown> = {};
let statesByRunId: Record<string, unknown> = {};

async function fakeApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  apiCalls.push({ method, path, body });
  const convMatch = /originConversationId=([^&]+)/.exec(path);
  if (convMatch?.[1] !== undefined) {
    const conv = decodeURIComponent(convMatch[1]);
    return recordsByConversation[conv] ?? [];
  }
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
  conversationId: string,
  kind = "ab-compare-hitl",
) {
  return {
    runId,
    kind,
    status,
    createdAt: "2026-07-02T10:00:00.000Z",
    originConversationId: conversationId,
  };
}

function logState(runId: string, phase: string, stepPhase: string) {
  return {
    runId,
    phase,
    lastSeq: 1,
    steps: [
      {
        stepId: "draft",
        phase: stepPhase,
        stepType: "deterministic",
        currentAttempt: 1,
      },
    ],
  };
}

let queryClient: QueryClient;

function renderPopup(conversationId: string | null = "conv-1") {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkflowDock
          conversationId={conversationId}
          tenantId={null}
          variant="popup"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiCalls = [];
  recordsByConversation = {};
  statesByRunId = {};
  localStorage.clear();
  sessionStorage.clear();
  mock.module("../lib/api", () => ({ ...apiActual, api: fakeApi }));
});

afterEach(() => {
  queryClient.clear();
  cleanup();
});

describe("WorkflowDock popup variant", () => {
  it("is hidden entirely when the conversation has no active run", async () => {
    recordsByConversation["conv-1"] = [];
    const { container } = renderPopup();
    await waitFor(() => expect(apiCalls.length).toBeGreaterThan(0));
    expect(container.querySelector("aside")).toBeNull();
  });

  it("opens collapsed by default when the conversation has an active run", async () => {
    recordsByConversation["conv-1"] = [
      listRow("run_running", "running", "conv-1"),
    ];
    statesByRunId["run_running"] = logState(
      "run_running",
      "running",
      "in-flight",
    );
    renderPopup();

    // Collapsed strip is present with the expand affordance and count, but the
    // heavy cards are not rendered until expanded.
    await waitFor(() => screen.getByLabelText("Expand workflows: 1 running"));
    expect(screen.queryByTestId("workflow-dock-card")).toBeNull();
    expect(screen.getByTestId("dock-rail-dot").textContent).toContain(
      "ab-compare-hitl: Running",
    );
  });

  it("expands to show the dock cards for the active run", async () => {
    recordsByConversation["conv-1"] = [
      listRow("run_running", "running", "conv-1"),
    ];
    statesByRunId["run_running"] = logState(
      "run_running",
      "running",
      "in-flight",
    );
    renderPopup();

    fireEvent.click(
      await waitFor(() => screen.getByLabelText("Expand workflows: 1 running")),
    );

    const card = await waitFor(() => screen.getByTestId("workflow-dock-card"));
    expect(card.textContent).toContain("ab-compare-hitl");
    expect(card.textContent).toContain("Running");
  });

  it("shows only the runs for its own conversation — no cross-conversation bleed", async () => {
    recordsByConversation["conv-1"] = [
      listRow("run_mine", "running", "conv-1", "pain-point-collateral"),
    ];
    recordsByConversation["conv-2"] = [
      listRow("run_other", "running", "conv-2", "ab-compare-hitl"),
    ];
    statesByRunId["run_mine"] = logState("run_mine", "running", "in-flight");
    statesByRunId["run_other"] = logState("run_other", "running", "in-flight");
    renderPopup("conv-1");

    fireEvent.click(
      await waitFor(() => screen.getByLabelText("Expand workflows: 1 running")),
    );
    await waitFor(() => screen.getByTestId("workflow-dock-card"));

    expect(screen.getAllByTestId("workflow-dock-card")).toHaveLength(1);
    expect(screen.getByText("pain-point-collateral")).toBeTruthy();
    expect(screen.queryByText("ab-compare-hitl")).toBeNull();
    // The query was scoped to conv-1 only; conv-2 was never fetched.
    expect(
      apiCalls.some((c) => c.path.includes("originConversationId=conv-2")),
    ).toBe(false);
  });

  it("collapses back to the strip after expanding", async () => {
    recordsByConversation["conv-1"] = [
      listRow("run_running", "running", "conv-1"),
    ];
    statesByRunId["run_running"] = logState(
      "run_running",
      "running",
      "in-flight",
    );
    renderPopup();

    fireEvent.click(
      await waitFor(() => screen.getByLabelText("Expand workflows: 1 running")),
    );
    await waitFor(() => screen.getByTestId("workflow-dock-card"));

    fireEvent.click(screen.getByLabelText("Collapse workflow dock"));
    expect(screen.queryByTestId("workflow-dock-card")).toBeNull();
    expect(screen.getByLabelText("Expand workflows: 1 running")).toBeTruthy();
  });
});
