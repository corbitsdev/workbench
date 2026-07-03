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
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router";
import type { ActivityOverview } from "../lib/hub-api";

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
  byWorkflowType: [
    {
      kind: "last30days",
      turnCount: 6,
      toolCallCount: 2,
      inputTokens: 500,
      outputTokens: 90,
    },
    {
      kind: "mvt-landing-page",
      turnCount: 2,
      toolCallCount: 1,
      inputTokens: 120,
      outputTokens: 30,
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
    byInstance: [] as ActivityOverview["inference"]["byInstance"],
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

function ActorProbe() {
  const { id } = useParams();
  const location = useLocation();
  return (
    <div data-testid="actor-probe">
      <span data-testid="probe-id">{id}</span>
      <span data-testid="probe-name">
        {(location.state as { displayName?: string } | null)?.displayName ?? ""}
      </span>
    </div>
  );
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/insights"]}>
        <Routes>
          <Route path="/insights" element={<InsightsDashboard />} />
          <Route path="/insights/users/:id" element={<ActorProbe />} />
        </Routes>
      </MemoryRouter>
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
      screen.getByText("Total turns");
    });
    expect(screen.getAllByText("12").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Tool calls").length).toBeGreaterThanOrEqual(1);
  });

  it("shows success-rate sub-labels for turns and tool calls", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("Total turns");
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

  it("does not draw misleading two-point trend lines for the 24-hour preset", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId("sparkline").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "24 hours" }));

    await waitFor(() => {
      expect(screen.queryByTestId("sparkline")).toBeNull();
    });
    expect(
      screen.getAllByText(
        "Trend line appears once 3+ daily buckets are selected",
      ).length,
    ).toBe(3);
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
      screen.getByText("Conversations");
    });
    screen.getByText("20");
    screen.getByText("Messages");
    screen.getByText("140");
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

  it("omits zero-turn models from the model distribution", async () => {
    mockOverview.models = [
      { key: "deepseek-v4-flash", count: 0 },
      { key: "kimi", count: 3 },
    ];
    try {
      renderPage();

      await waitFor(() => {
        expect(screen.getAllByTestId("mini-bar").length).toBe(1);
      });
      expect(screen.getByTestId("mini-bar").getAttribute("data-label")).toBe(
        "kimi",
      );
      expect(screen.queryByText("deepseek-v4-flash")).toBeNull();
    } finally {
      mockOverview.models = [
        { key: "deepseek-v4-flash", count: 9 },
        { key: "kimi", count: 3 },
      ];
    }
  });

  it("renders operational ledger totals from activity overview", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("Operational ledger");
    });
    screen.getByText("Artifacts");
    screen.getByText("Workflow runs");
  });

  it("renders tokens by workflow type with humanized kind labels", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("Tokens by workflow type");
    });
    // Kinds are humanized from kebab-case to Title Case.
    const row = screen.getByText("Mvt Landing Page").closest("tr");
    // Tokens = input 120 + output 30 = 150.
    expect(row?.textContent).toContain("150");
    screen.getByText("Last30days");
    // The removed "By agent" section no longer renders.
    expect(screen.queryByText("By agent")).toBeNull();
  });

  it("flags the tokens-by-workflow-type table with a caveat note across the live/history boundary", async () => {
    const original = mockOverview.tokensRecordedFrom;
    mockOverview.tokensRecordedFrom = isoDay(-1);
    try {
      renderPage();

      await waitFor(() => {
        screen.getByText("Tokens by workflow type");
      });
      const section = screen
        .getByText("Tokens by workflow type")
        .closest("div");
      const caveat = section?.querySelector('[data-testid="data-caveat"]');
      expect(caveat?.textContent).toContain("not recorded");
    } finally {
      mockOverview.tokensRecordedFrom = original;
    }
  });

  it("lets the date-preset row wrap and the breakdown tables scroll within themselves at mobile widths", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("By person");
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
      screen.getByText("By person");
    });
    screen.getByText("Sawyer");
    screen.getByText("(me)");
    screen.getByText("Dana");
    // Total row: turns 8 + 4 = 12. Footer is labeled as attributed-only since
    // shared-agent usage is excluded from the per-person breakdown.
    const total = screen.getByText("Attributed total").closest("tr");
    expect(total?.textContent).toContain("12");
    // Combined token total shown as a real value (default mock has old
    // tokensRecordedFrom): inputTokens 1000 + outputTokens 150 = 1,150.
    expect(total?.textContent).toContain("1,150");
    screen.getByText("Excludes shared agents");
  });

  it("navigates to the actor detail page when a By-person row is clicked", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("Dana");
    });
    fireEvent.click(screen.getByText("Dana"));

    await waitFor(() => {
      screen.getByTestId("actor-probe");
    });
    expect(screen.getByTestId("probe-id").textContent).toBe("pri_other");
    // The clicked row seeds the detail page with the actor via router state so
    // identity renders instantly before the id-based fetch resolves.
    expect(screen.getByTestId("probe-name").textContent).toBe("Dana");
  });

  it("orders the By-person table by tokens and lists Turns before Tool calls", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("By person");
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

  it("keeps the By-person table in server token order even under the token caveat", async () => {
    const original = mockOverview.tokensRecordedFrom;
    const originalPeople = mockOverview.byPerson;
    mockOverview.tokensRecordedFrom = isoDay(-1);
    // Server order is token-desc: Dana (9000) ahead of Sawyer (10).
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
        screen.getByText("By person");
      });
      const personTable = screen.getByText("Person").closest("table");
      const bodyRows = Array.from(
        personTable?.querySelectorAll("tbody tr") ?? [],
      );
      // Tokens stay visible under the caveat, so the server's token ordering
      // holds: Dana (9,000) ahead of Sawyer (10).
      expect(bodyRows[0]?.textContent).toContain("Dana");
      expect(bodyRows[1]?.textContent).toContain("Sawyer");
    } finally {
      mockOverview.tokensRecordedFrom = original;
      mockOverview.byPerson = originalPeople;
    }
  });

  it("shows per-person token totals with a caveat note when the range crosses the live/history boundary", async () => {
    const original = mockOverview.tokensRecordedFrom;
    mockOverview.tokensRecordedFrom = isoDay(-1);
    try {
      renderPage();

      await waitFor(() => {
        screen.getByText("By person");
      });
      const sawyerRow = screen.getByText("Sawyer").closest("tr");
      // Tokens are shown (input 700 + output 90 = 790), not hidden.
      expect(sawyerRow?.textContent).toContain("790");
      // The range is still flagged with a caveat note.
      expect(
        screen
          .getAllByTestId("data-caveat")
          .some((n) => n.textContent?.includes("not recorded")),
      ).toBe(true);
    } finally {
      mockOverview.tokensRecordedFrom = original;
    }
  });

  it("still renders the token mix with a caveat note when the range crosses the live/history boundary", async () => {
    const original = mockOverview.tokensRecordedFrom;
    mockOverview.tokensRecordedFrom = isoDay(-1);
    try {
      renderPage();

      await waitFor(() => {
        expect(screen.getAllByTestId("data-caveat").length).toBeGreaterThan(0);
      });
      // Real token data exists, so the mosaic renders rather than hiding.
      screen.getByTestId("token-mosaic");
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
      screen.getByText("Operational ledger");
    });
    expect(lastTenantId).toBe("tenant-1");
    screen.getByText("Acme Corp");
  });

  it("offers a 24 hours preset", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("Operational ledger");
    });
    screen.getByText("24 hours");
  });

  it("labels agent instances as Agents deployed and drops the Deployments stat", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("Operational ledger");
    });
    screen.getByText("Agents deployed");
    expect(screen.queryByText("Agent instances")).toBeNull();
    expect(screen.queryByText("Deployments")).toBeNull();
  });

  it("lets the operational-ledger tables size to their content rather than stretching", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("Artifacts by status");
    });
    const tablesGrid = screen.getByText("Artifacts by status").closest(".grid");
    expect(tablesGrid?.className).toContain("items-start");
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
        screen.getByText("By agent instance");
      });
      const table = screen.getByText("Instance").closest("table");
      const bodyRowCount = () =>
        table?.querySelectorAll("tbody tr").length ?? 0;
      // First page shows 10 of 23.
      expect(bodyRowCount()).toBe(10);
      screen.getByText("Showing 10 of 23");

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
