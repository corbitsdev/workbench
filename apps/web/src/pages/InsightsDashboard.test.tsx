/// <reference types="bun" />
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

let activeContext: {
  workbenches: unknown[];
  loading: boolean;
  activeWorkbench: { id: string; tenantId: string; tenantName: string } | null;
  activeTenantId: string | null;
  setActiveWorkbench: () => void;
} = {
  workbenches: [],
  loading: false,
  activeWorkbench: { id: "p1", tenantId: "tenant-1", tenantName: "Acme Corp" },
  activeTenantId: "tenant-1",
  setActiveWorkbench: () => {},
};

mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => activeContext,
}));

let lastTenantId: string | null = null;

// Use recent dates so the default 30-day preset's gap-fill always includes
// them, regardless of when the suite runs.
const isoDay = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const DAY_A = isoDay(3);
const DAY_B = isoDay(2);

const mockOverview = {
  tenantId: "tenant-1",
  range: {},
  artifacts: {
    total: 5,
    createdInRange: 2,
    byStatus: [{ key: "ready", count: 4 }],
    byKind: [{ key: "brief", count: 3 }],
  },
  workflowRuns: {
    executionRecords: 8,
    executionsStartedInRange: 3,
    activeExecutions: 1,
    byStatus: [{ key: "completed", count: 6 }],
    byKind: [{ key: "call-to-collateral", count: 8 }],
    deploymentsIndexed: 2,
  },
  agentInstances: { active: 2, startedInRange: 1, endedInRange: 0, total: 4 },
  agentActivity: { active: 1, idle: 3 },
  conversations: { total: 20, createdInRange: 7 },
  messages: { total: 140, createdInRange: 35 },
  dailySeries: [
    {
      date: DAY_A,
      turnCount: 4,
      failedTurnCount: 0,
      toolCallCount: 1,
      toolErrorCount: 0,
      inputTokens: 400,
      outputTokens: 80,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
    {
      date: DAY_B,
      turnCount: 8,
      failedTurnCount: 0,
      toolCallCount: 3,
      toolErrorCount: 0,
      inputTokens: 600,
      outputTokens: 120,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
  ],
  models: [
    { key: "deepseek-v4-flash", count: 9 },
    { key: "kimi", count: 3 },
  ],
  tokensRecordedFrom: "2000-01-01",
  byPerson: [
    {
      principalId: "pri_me",
      name: "Sawyer",
      isSelf: true,
      turnCount: 8,
      toolCallCount: 3,
      inputTokens: 700,
      outputTokens: 90,
    },
    {
      principalId: "pri_other",
      name: "Dana",
      isSelf: false,
      turnCount: 4,
      toolCallCount: 1,
      inputTokens: 300,
      outputTokens: 60,
    },
  ],
  inference: {
    summary: {
      tenantId: "tenant-1",
      turnCount: 12,
      failedTurnCount: 0,
      toolCallCount: 4,
      toolErrorCount: 0,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
    previousSummary: {
      tenantId: "tenant-1",
      turnCount: 6,
      failedTurnCount: 0,
      toolCallCount: 2,
      toolErrorCount: 0,
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
    byAgent: [
      {
        agentId: "agt_myra",
        agentName: "Myra",
        turnCount: 10,
        failedTurnCount: 0,
        toolCallCount: 3,
        toolErrorCount: 0,
        inputTokens: 800,
        outputTokens: 150,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
      },
    ],
    byInstance: [],
  },
};

mock.module("../lib/hub-api", () => ({
  getActivityOverview: (tenantId: string) => {
    lastTenantId = tenantId;
    return Promise.resolve(mockOverview);
  },
  describeHubApiFailure: (e: unknown) => String(e),
}));

import { InsightsDashboard } from "./InsightsDashboard";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InsightsDashboard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/insights");
  lastTenantId = null;
  activeContext = {
    workbenches: [],
    loading: false,
    activeWorkbench: {
      id: "p1",
      tenantId: "tenant-1",
      tenantName: "Acme Corp",
    },
    activeTenantId: "tenant-1",
    setActiveWorkbench: () => {},
  };
});

afterEach(() => {
  cleanup();
});

describe("InsightsDashboard", () => {
  it("renders turn and tool-call totals from the analytics summary", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Total turns")).toBeDefined();
    });
    expect(screen.getAllByText("12").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Tool calls").length).toBeGreaterThanOrEqual(1);
  });

  it("shows success-rate sub-labels for turns and tool calls", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Total turns")).toBeDefined();
    });
    expect(screen.getAllByText("100.0% success").length).toBe(2);
    expect(screen.queryByText(/failure rate/)).toBeNull();
  });

  it("renders a sparkline spanning the gap-filled day spine", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId("sparkline").length).toBeGreaterThanOrEqual(
        1,
      );
    });
    const sparks = screen.getAllByTestId("sparkline");
    // 30d preset fills a continuous spine, so there are more points than the
    // two active days in the mock series.
    expect(Number(sparks[0].getAttribute("data-point-count"))).toBeGreaterThan(
      2,
    );
  });

  it("renders heatmap cells carrying each active day's turn count", async () => {
    renderPage();

    await waitFor(() => {
      expect(
        screen.getAllByTestId("heatmap-cell").length,
      ).toBeGreaterThanOrEqual(2);
    });
    const heatmap = screen.getByTestId("heatmap");
    expect(
      heatmap.querySelector(`[data-date="${DAY_A}"][data-value="4"]`),
    ).not.toBeNull();
    expect(
      heatmap.querySelector(`[data-date="${DAY_B}"][data-value="8"]`),
    ).not.toBeNull();
  });

  it("renders an upward delta badge when the current window beats the previous", async () => {
    renderPage();

    await waitFor(() => {
      expect(
        screen.getAllByTestId("delta-badge").length,
      ).toBeGreaterThanOrEqual(1);
    });
    const up = screen
      .getAllByTestId("delta-badge")
      .filter((b) => b.getAttribute("data-direction") === "up");
    // turns 12 vs 6 = +100%
    expect(up.some((b) => b.textContent?.includes("100%"))).toBe(true);
  });

  it("renders engagement conversation and message counts", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Conversations")).toBeDefined();
    });
    expect(screen.getByText("20")).toBeDefined();
    expect(screen.getByText("Messages")).toBeDefined();
    expect(screen.getByText("140")).toBeDefined();
  });

  it("renders the model distribution as mini bars", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId("mini-bar").length).toBe(2);
    });
    const bars = screen.getAllByTestId("mini-bar");
    expect(bars[0].getAttribute("data-label")).toBe("deepseek-v4-flash");
    expect(bars[0].getAttribute("data-value")).toBe("9");
  });

  it("renders operational ledger totals from activity overview", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Operational ledger")).toBeDefined();
    });
    expect(screen.getByText("Artifacts")).toBeDefined();
    expect(screen.getByText("Workflow runs")).toBeDefined();
  });

  it("renders per-agent breakdown when by-agent data is available", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Myra")).toBeDefined();
    });
    expect(screen.getByText("10")).toBeDefined();
  });

  it("lets the date-preset row wrap and the breakdown tables scroll within themselves at mobile widths", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("By person")).toBeDefined();
    });

    // The preset buttons wrap rather than forcing the header past the viewport.
    const presetGroup = screen.getByText("7 days").parentElement;
    expect(presetGroup?.className).toContain("flex-wrap");

    // Each breakdown table is min-width-constrained, so it must live inside an
    // overflow-x-auto wrapper that scrolls the table — not the page.
    const personTable = screen.getByText("Person").closest("table");
    expect(personTable?.className).toContain("min-w-[520px]");
    expect(personTable?.parentElement?.className).toContain("overflow-x-auto");
  });

  it("renders a By-person breakdown marking the caller and a total row", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("By person")).toBeDefined();
    });
    expect(screen.getByText("Sawyer")).toBeDefined();
    expect(screen.getByText("(me)")).toBeDefined();
    expect(screen.getByText("Dana")).toBeDefined();
    // Total row: turns 8 + 4 = 12. Footer is labeled as attributed-only since
    // shared-agent usage is excluded from the per-person breakdown.
    const total = screen.getByText("Attributed total").closest("tr");
    expect(total?.textContent).toContain("12");
    // Combined token total shown as a real value (default mock has old
    // tokensRecordedFrom): inputTokens 1000 + outputTokens 150 = 1,150.
    expect(total?.textContent).toContain("1,150");
    expect(screen.getByText("Excludes shared agents")).toBeDefined();
  });

  it("orders the By-person table by tokens and lists Turns before Tool calls", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("By person")).toBeDefined();
    });
    const personTable = screen.getByText("Person").closest("table");
    const headers = Array.from(
      personTable?.querySelectorAll("thead th") ?? [],
    ).map((th) => th.textContent);
    expect(headers).toEqual(["Person", "Turns", "Tool calls", "Tokens"]);
    // No caveat in the default mock: rows stay in server token order
    // (Sawyer 790 tokens before Dana 360).
    const bodyRows = Array.from(
      personTable?.querySelectorAll("tbody tr") ?? [],
    );
    expect(bodyRows[0]?.textContent).toContain("Sawyer");
    expect(bodyRows[1]?.textContent).toContain("Dana");
  });

  it("re-orders the By-person table by a visible metric (turns) under the token caveat", async () => {
    const original = mockOverview.tokensRecordedFrom;
    // Make Dana out-rank Sawyer on tokens but trail on turns, so token-order
    // and turn-order disagree.
    const originalPeople = mockOverview.byPerson;
    mockOverview.tokensRecordedFrom = isoDay(-1);
    mockOverview.byPerson = [
      {
        principalId: "pri_other",
        name: "Dana",
        isSelf: false,
        turnCount: 1,
        toolCallCount: 1,
        inputTokens: 9000,
        outputTokens: 0,
      },
      {
        principalId: "pri_me",
        name: "Sawyer",
        isSelf: true,
        turnCount: 50,
        toolCallCount: 3,
        inputTokens: 10,
        outputTokens: 0,
      },
    ];
    try {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText("By person")).toBeDefined();
      });
      const personTable = screen.getByText("Person").closest("table");
      const bodyRows = Array.from(
        personTable?.querySelectorAll("tbody tr") ?? [],
      );
      // Under the caveat tokens are hidden, so the visible Turns column drives
      // the order: Sawyer (50 turns) ahead of Dana (1 turn).
      expect(bodyRows[0]?.textContent).toContain("Sawyer");
      expect(bodyRows[1]?.textContent).toContain("Dana");
    } finally {
      mockOverview.tokensRecordedFrom = original;
      mockOverview.byPerson = originalPeople;
    }
  });

  it("hides token-cost columns in the By-person table when the range crosses the live/history boundary", async () => {
    const original = mockOverview.tokensRecordedFrom;
    mockOverview.tokensRecordedFrom = isoDay(-1);
    try {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText("By person")).toBeDefined();
      });
      const sawyerRow = screen.getByText("Sawyer").closest("tr");
      // Token columns collapse to em-dashes; turns/tools still show.
      expect(sawyerRow?.textContent).not.toContain("700");
      expect(sawyerRow?.textContent).toContain("—");
    } finally {
      mockOverview.tokensRecordedFrom = original;
    }
  });

  it("caveats token cards and hides token-cost for a range crossing the live/history boundary", async () => {
    const original = mockOverview.tokensRecordedFrom;
    // Token recording begins in the future, so every preset range starts before
    // it — the whole selectable window is history with no real token data.
    mockOverview.tokensRecordedFrom = isoDay(-1);
    try {
      renderPage();

      await waitFor(() => {
        expect(screen.getAllByTestId("data-caveat").length).toBeGreaterThan(0);
      });
      // The token-cost mosaic must not present zero-filled history as a real
      // breakdown.
      expect(screen.queryByTestId("token-mosaic")).toBeNull();
      expect(
        screen
          .getAllByTestId("data-caveat")
          .some((n) => n.textContent?.includes("not recorded")),
      ).toBe(true);
    } finally {
      mockOverview.tokensRecordedFrom = original;
    }
  });

  it("scopes analytics queries to the active workbench tenant and shows its name", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Operational ledger")).toBeDefined();
    });
    expect(lastTenantId).toBe("tenant-1");
    expect(screen.getByText("Acme Corp")).toBeDefined();
  });

  it("offers a 24 hours preset", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Operational ledger")).toBeDefined();
    });
    expect(screen.getByText("24 hours")).toBeDefined();
  });

  it("labels agent instances as Agents deployed and drops the Deployments stat", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Operational ledger")).toBeDefined();
    });
    expect(screen.getByText("Agents deployed")).toBeDefined();
    expect(screen.queryByText("Agent instances")).toBeNull();
    expect(screen.queryByText("Deployments")).toBeNull();
  });

  it("paginates the By-agent-instance table 10 at a time", async () => {
    const original = mockOverview.inference.byInstance;
    mockOverview.inference.byInstance = Array.from({ length: 23 }, (_, i) => ({
      instanceId: `ins_${i}`,
      agentId: `agt_${i}`,
      agentName: `Agent ${i}`,
      turnCount: i,
      failedTurnCount: 0,
      toolCallCount: 0,
      toolErrorCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    }));
    try {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText("By agent instance")).toBeDefined();
      });
      const table = screen.getByText("Instance").closest("table");
      const bodyRowCount = () =>
        table?.querySelectorAll("tbody tr").length ?? 0;
      // First page shows 10 of 23.
      expect(bodyRowCount()).toBe(10);
      expect(screen.getByText("Showing 10 of 23")).toBeDefined();

      fireEvent.click(screen.getByText("Show 10 more"));
      expect(bodyRowCount()).toBe(20);

      // Last page clamps to the remaining 3.
      fireEvent.click(screen.getByText("Show 3 more"));
      expect(bodyRowCount()).toBe(23);
      expect(screen.queryByText(/Show \d+ more/)).toBeNull();
    } finally {
      mockOverview.inference.byInstance = original;
    }
  });

  it("shows a select-a-workbench state and fires no query when no workbench is active", async () => {
    activeContext = {
      workbenches: [],
      loading: false,
      activeWorkbench: null,
      activeTenantId: null,
      setActiveWorkbench: () => {},
    };
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText("Select a workbench to view analytics."),
      ).toBeDefined();
    });
    expect(lastTenantId).toBeNull();
  });
});
