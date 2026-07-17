import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import * as apiActual from "../lib/api";
import { SubagentDock } from "./SubagentDock";

type ApiCall = { method: string; path: string; body?: unknown };

let apiCalls: ApiCall[] = [];
let subagents: unknown = [];

async function fakeApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  apiCalls.push({ method, path, body });
  if (path.includes("/invoked-subagents")) {
    return { subagents };
  }
  throw new Error(`unexpected api call: ${method} ${path}`);
}

function row(sessionStatus: string | null, agentName = "Researcher") {
  return {
    mappingId: `map-${agentName}`,
    agentId: "agt-1",
    agentName,
    instanceId: "inst-1",
    instanceAddress: "researcher.local",
    sessionId: sessionStatus === "active" ? "sess-1" : null,
    sessionStatus,
    lastActivityAt: "2026-07-02T10:00:00.000Z",
    firstInvokedAt: "2026-07-02T09:00:00.000Z",
    lastInvokedAt: "2026-07-02T10:00:00.000Z",
    originConversationId: "conv-1",
  };
}

mock.module("../lib/use-agent-phase", () => ({
  useAgentPhase: () => null,
}));

let queryClient: QueryClient;

function renderDock(conversationId: string | null = "conv-1") {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SubagentDock conversationId={conversationId} tenantId="tn-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiCalls = [];
  subagents = [];
  localStorage.clear();
  mock.module("../lib/api", () => ({ ...apiActual, api: fakeApi }));
});

afterEach(() => {
  queryClient.clear();
  cleanup();
});

describe("SubagentDock", () => {
  it("renders nothing and issues no query without a conversation id", async () => {
    const { container } = renderDock(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector("aside")).toBeNull();
    expect(apiCalls).toHaveLength(0);
  });

  it("is hidden when the conversation has no invoked subagents", async () => {
    subagents = [];
    const { container } = renderDock();
    await waitFor(() => expect(apiCalls.length).toBeGreaterThan(0));
    expect(container.querySelector("aside")).toBeNull();
  });

  it("is hidden on fresh load when every subagent session has ended", async () => {
    subagents = [row("ended")];
    const { container } = renderDock();
    await waitFor(() => expect(apiCalls.length).toBeGreaterThan(0));
    expect(container.querySelector("aside")).toBeNull();
  });

  it("renders active subagents sorted with running first", async () => {
    subagents = [row("ended", "DoneBot"), row("active", "LiveBot")];
    renderDock();

    const cards = await waitFor(() => {
      const found = screen.getAllByTestId("subagent-dock-card");
      expect(found).toHaveLength(2);
      return found;
    });

    expect(cards[0]?.textContent).toContain("LiveBot");
    expect(cards[0]?.textContent).toContain("Running");
    expect(cards[1]?.textContent).toContain("DoneBot");
    expect(cards[1]?.textContent).toContain("Done");
  });
});
