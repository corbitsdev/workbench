/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
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

// The Agents tab owns its own roster query lifecycle; stub it so the
// dashboard test stays hermetic and never reaches for the network.
mock.module("../hooks/use-tenant-roster", () => ({
  useTenantRoster: () => ({
    data: { instances: [], runs: [] },
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
}));

mock.module("../hooks/use-model-pricing", () => ({
  useModelPricing: () => ({
    data: {
      source: "models.dev",
      generatedAt: "2026-01-01",
      models: {},
      qualified: {},
      ambiguous: [],
    },
    isLoading: false,
    isSuccess: true,
    isError: false,
  }),
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
  metricsBucket: "day",
  metricsSeries: [
    {
      bucketStart: DAY_A,
      agentsDeployed: 1,
      agentsActive: 2,
      tokensSpent: 480,
      artifactsCreated: 1,
    },
    {
      bucketStart: DAY_B,
      agentsDeployed: 0,
      agentsActive: 2,
      tokensSpent: 720,
      artifactsCreated: 0,
    },
  ],
  models: [
    { key: "deepseek-v4-flash", count: 9 },
    { key: "kimi", count: 3 },
  ],
  byModel: [
    {
      model: "deepseek-v4-flash",
      turnCount: 9,
      inputTokens: 700,
      outputTokens: 150,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
    {
      model: "kimi",
      turnCount: 3,
      inputTokens: 300,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    },
  ],
  pricedByModel: null,
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
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
      cost: null,
    },
    {
      principalId: "pri_other",
      name: "Dana",
      isSelf: false,
      turnCount: 4,
      toolCallCount: 1,
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
      cost: null,
    },
  ],
  byWorkflowType: [
    {
      kind: "last30days",
      turnCount: 6,
      toolCallCount: 2,
      inputTokens: 500,
      outputTokens: 90,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
      cost: null,
    },
    {
      kind: "mvt-landing-page",
      turnCount: 2,
      toolCallCount: 1,
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
      cost: null,
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

let lastRange: { startDate?: string; endDate?: string } | undefined;
let lastExportOpts:
  | { startDate?: string; endDate?: string; bucket?: string }
  | undefined;
let overviewReject: Error | null = null;

mock.module("../lib/hub-api", () => ({
  getActivityOverview: (
    tenantId: string,
    opts?: { startDate?: string; endDate?: string },
  ) => {
    lastTenantId = tenantId;
    lastRange = opts;
    if (overviewReject) return Promise.reject(overviewReject);
    return Promise.resolve(mockOverview);
  },
  downloadActivityExportCsv: (
    tenantId: string,
    opts?: { startDate?: string; endDate?: string; bucket?: string },
  ) => {
    lastTenantId = tenantId;
    lastExportOpts = opts;
    return Promise.resolve({
      csv: "[metrics_series]\nbucket_start,agents_deployed\n2026-01-01,1\n",
      filename: "insights-day-2026-01-01_2026-01-31.csv",
    });
  },
  describeHubApiFailure: (e: unknown) => String(e),
}));

import {
  InsightsDashboard,
  filterPeople,
  mergeWorkflowKindRows,
  resolveRange,
} from "./InsightsDashboard";

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

function renderPage(initialEntry = "/insights") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/insights" element={<InsightsDashboard />} />
          <Route path="/insights/users/:id" element={<ActorProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function goToTab(name: string) {
  fireEvent.click(screen.getByTestId(`insights-tab-${name}`));
}

function renderRoutedPage(initialPath = "/insights") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [{ path: "/insights", element: <InsightsDashboard /> }],
    { initialEntries: [initialPath] },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, ...view };
}

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/insights");
  lastTenantId = null;
  lastRange = undefined;
  overviewReject = null;
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

describe("InsightsDashboard tab shell", () => {
  it("defaults to the overview tab and shows the KPI row", async () => {
    renderPage();
    await screen.findByText("This range");
    expect(
      screen.getByTestId("insights-tab-overview").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("persists the shared range header while switching tabs", async () => {
    renderPage();
    await screen.findByText("This range");
    goToTab("people");
    // The header (tenant name + preset controls) stays mounted across tabs.
    expect(screen.getByText("Acme Corp")).toBeDefined();
    expect(screen.getByText("24 hours")).toBeDefined();
  });

  it("selects the tab from the ?tab= search param", async () => {
    renderPage("/insights?tab=workflows");
    await waitFor(() => {
      expect(
        screen
          .getByTestId("insights-tab-workflows")
          .getAttribute("aria-selected"),
      ).toBe("true");
    });
    screen.getByText("Workflow runs by kind");
  });

  it("falls back to overview for an unrecognized tab value", async () => {
    renderPage("/insights?tab=bogus");
    await waitFor(() => {
      expect(
        screen
          .getByTestId("insights-tab-overview")
          .getAttribute("aria-selected"),
      ).toBe("true");
    });
  });

  it("switches sub-page content and the URL on tab click, and Back returns to the previous tab", async () => {
    const { router } = renderRoutedPage();
    await screen.findByText("This range");

    // Overview content is present, People content is not.
    screen.getByText("Total activity");
    expect(screen.queryByTestId("sortable-table")).toBeNull();

    goToTab("people");
    await waitFor(() => {
      expect(
        screen.getByTestId("insights-tab-people").getAttribute("aria-selected"),
      ).toBe("true");
    });
    // The People sub-page actually replaced the Overview content.
    expect(screen.queryByText("Total activity")).toBeNull();
    await screen.findByText(/Excludes shared agents/);
    expect(router.state.location.search).toBe("?tab=people");

    goToTab("workflows");
    await waitFor(() => {
      expect(router.state.location.search).toBe("?tab=workflows");
    });
    expect(screen.queryByText(/Excludes shared agents/)).toBeNull();
    await screen.findByText("Open run history →");

    // Each tab click pushed its own history entry, so Back steps through
    // the tabs the member actually visited instead of skipping over them.
    await router.navigate(-1);
    await waitFor(() => {
      expect(router.state.location.search).toBe("?tab=people");
    });
    await screen.findByText(/Excludes shared agents/);

    await router.navigate(-1);
    await waitFor(() => {
      expect(router.state.location.search).toBe("");
    });
    await screen.findByText("Total activity");
  });

  it("navigates to the usage-cost tab when a KPI tile is clicked", async () => {
    renderPage();
    await screen.findByText("This range");
    fireEvent.click(screen.getByLabelText("View cost on the usage-cost tab"));
    await waitFor(() => {
      expect(
        screen
          .getByTestId("insights-tab-usage-cost")
          .getAttribute("aria-selected"),
      ).toBe("true");
    });
  });

  it("scopes analytics queries to the active workbench tenant and shows its name", async () => {
    renderPage();
    await waitFor(() => {
      screen.getByText("Operational ledger");
    });
    expect(lastTenantId).toBe("tenant-1");
    screen.getByText("Acme Corp");
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

  it("surfaces a plain-language error when the overview query fails", async () => {
    overviewReject = new Error("overview boom");
    renderPage();
    await screen.findByText(/overview boom/);
  });
});

describe("InsightsDashboard overview tab", () => {
  it("computes KPI tiles from the loaded range", async () => {
    renderPage();
    await screen.findByText("This range");
    const kpi = screen.getByText("This range").closest("div")!;
    expect(within(kpi).getByText("Total activity")).toBeDefined();
    expect(within(kpi).getByText("16")).toBeDefined();
    const workflowRunsTile = within(kpi)
      .getByText("Workflow runs")
      .closest("div");
    expect(within(workflowRunsTile!).getByText("3")).toBeDefined();
    expect(within(kpi).getByText("Active actors")).toBeDefined();
  });

  it("renders the activity-over-time chart with an a11y table fallback", async () => {
    renderPage();
    await waitFor(() => {
      expect(
        screen.getAllByTestId("time-series-chart").length,
      ).toBeGreaterThanOrEqual(1);
    });
    expect(
      screen.getAllByTestId("time-series-table").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("renders engagement conversation and message counts", async () => {
    renderPage();
    await waitFor(() => {
      screen.getByText("Conversations");
    });
    screen.getByText("7");
    screen.getByText("Messages");
    screen.getByText("35");
  });

  it("renders operational ledger totals without the removed workflow-kind duplicate", async () => {
    renderPage();
    await waitFor(() => {
      screen.getByText("Operational ledger");
    });
    screen.getByText("Artifacts by status");
    // The workflow-runs-by-kind CountTable duplicate was removed from the
    // ledger — that breakdown now lives only on the Workflows tab.
    expect(screen.queryByText("Workflow runs by kind")).toBeNull();
    expect(screen.queryByText("Workflow runs by status")).toBeNull();
  });

  it("requeries with a custom date range once a start date is entered", async () => {
    renderPage();
    await screen.findByText("This range");
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByTestId("custom-start"), {
      target: { value: "2026-05-01" },
    });
    await waitFor(() => {
      expect(lastRange?.startDate).toBe("2026-05-01");
    });
  });

  it("downloads server-side export CSV when Export CSV is clicked", async () => {
    renderPage();
    const button = (await screen.findByRole("button", {
      name: /export csv/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    const createObjectURL = mock(() => "blob:mock-url");
    const revokeObjectURL = mock(() => {});
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL =
      createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL =
      revokeObjectURL as unknown as typeof URL.revokeObjectURL;

    const clickSpy = mock(() => {});
    const realCreateElement = document.createElement.bind(document);
    let anchor: HTMLAnchorElement | null = null;
    document.createElement = ((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === "a") {
        el.click = clickSpy;
        anchor = el as HTMLAnchorElement;
      }
      return el;
    }) as unknown as typeof document.createElement;

    try {
      fireEvent.click(button);
      await waitFor(() => {
        expect(createObjectURL).toHaveBeenCalledTimes(1);
      });
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(lastExportOpts?.bucket).toBe("day");
      expect((anchor as HTMLAnchorElement | null)?.download).toBe(
        "insights-day-2026-01-01_2026-01-31.csv",
      );
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      document.createElement =
        realCreateElement as unknown as typeof document.createElement;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it("disables Export CSV and explains why when there is no metrics data", async () => {
    const original = mockOverview.metricsSeries;
    mockOverview.metricsSeries = [];
    try {
      renderPage();
      const button = (await screen.findByRole("button", {
        name: /export csv/i,
      })) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("title")).toBe(
        "No metrics to export for this range",
      );
    } finally {
      mockOverview.metricsSeries = original;
    }
  });
});

describe("InsightsDashboard usage-cost tab", () => {
  it("renders a sparkline spanning the gap-filled day spine", async () => {
    renderPage("/insights?tab=usage-cost");
    await waitFor(() => {
      expect(screen.getAllByTestId("sparkline").length).toBeGreaterThanOrEqual(
        1,
      );
    });
    const sparks = screen.getAllByTestId("sparkline");
    expect(Number(sparks[0].getAttribute("data-point-count"))).toBeGreaterThan(
      2,
    );
  });

  it("renders heatmap cells carrying each active day's turn count", async () => {
    renderPage("/insights?tab=usage-cost");
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
    renderPage("/insights?tab=usage-cost");
    await waitFor(() => {
      expect(
        screen.getAllByTestId("delta-badge").length,
      ).toBeGreaterThanOrEqual(1);
    });
    const up = screen
      .getAllByTestId("delta-badge")
      .filter((b) => b.getAttribute("data-direction") === "up");
    expect(up.some((b) => b.textContent?.includes("100%"))).toBe(true);
  });

  it("shows success-rate stats without repeating the trend cards' turn/tool totals", async () => {
    renderPage("/insights?tab=usage-cost");
    await waitFor(() => {
      screen.getByText("Chat success rate");
    });
    // The old duplicate "Total turns"/"Tool calls" stat tiles are gone.
    expect(screen.queryByText("Total turns")).toBeNull();
  });

  it("renders the model distribution as mini bars", async () => {
    renderPage("/insights?tab=usage-cost");
    await waitFor(() => {
      expect(screen.getAllByTestId("mini-bar").length).toBe(2);
    });
    const bars = screen.getAllByTestId("mini-bar");
    expect(bars[0].getAttribute("data-label")).toBe("deepseek-v4-flash");
    expect(bars[0].getAttribute("data-value")).toBe("850");
    expect(bars[0].textContent).toContain("9 chats");
    expect(bars[1].getAttribute("data-value")).toBe("350");
    expect(bars[1].textContent).toContain("3 chats");
  });

  it("uses token totals for mini-bar height when a model has zero turns", async () => {
    const originalByModel = mockOverview.byModel;
    mockOverview.byModel = [
      {
        model: "kimi-k2.6",
        turnCount: 0,
        inputTokens: 40_000,
        outputTokens: 20_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
      },
    ];
    try {
      renderPage("/insights?tab=usage-cost");
      await waitFor(() => {
        expect(screen.getAllByTestId("mini-bar").length).toBe(1);
      });
      const bar = screen.getAllByTestId("mini-bar")[0];
      expect(bar.getAttribute("data-value")).toBe("60000");
      expect(bar.textContent).toContain("60k");
    } finally {
      mockOverview.byModel = originalByModel;
    }
  });

  it("lists a zero-turn model in the cost table with token figures", async () => {
    const originalByModel = mockOverview.byModel;
    mockOverview.byModel = [
      {
        model: "kimi-k2.6",
        turnCount: 0,
        inputTokens: 40_000,
        outputTokens: 20_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
      },
    ];
    try {
      renderPage("/insights?tab=usage-cost");
      const costSection = await screen.findByTestId("cost-insights");
      expect(within(costSection).getByText("kimi-k2.6")).toBeDefined();
      expect(within(costSection).getByText("40,000")).toBeDefined();
      expect(within(costSection).getByText("20,000")).toBeDefined();
    } finally {
      mockOverview.byModel = originalByModel;
    }
  });

  it("lists every model with recorded usage in the cost table, marking unpriced ones", async () => {
    renderPage("/insights?tab=usage-cost");
    await screen.findByTestId("cost-insights");
    const costSection = screen.getByTestId("cost-insights");
    // Both models appear even though neither resolved a rate in this fixture
    // (models.dev catalog stub has no entries) — nothing is silently dropped.
    expect(within(costSection).getByText("deepseek-v4-flash")).toBeDefined();
    expect(within(costSection).getByText("kimi")).toBeDefined();
    expect(within(costSection).getAllByText("no rate").length).toBe(2);
  });

  it("does not leave an empty wrapper for activity trends when there is no daily series", async () => {
    const original = mockOverview.dailySeries;
    mockOverview.dailySeries = [];
    try {
      renderPage("/insights?tab=usage-cost");
      await waitFor(() => {
        screen.getByText("Chat success rate");
      });
      expect(screen.queryByText("Activity trends")).toBeNull();
    } finally {
      mockOverview.dailySeries = original;
    }
  });
});

describe("InsightsDashboard workflows tab", () => {
  it("renders workflow runs by kind, merging run counts with per-kind usage", async () => {
    renderPage("/insights?tab=workflows");

    const wfTable = await screen.findByTestId("sortable-table");
    expect(wfTable.textContent).toContain("Call To Collateral");
    expect(wfTable.textContent).toContain("Last30days");
    const row = within(wfTable).getByText("Mvt Landing Page").closest("tr");
    expect(row?.textContent).toContain("150");
  });

  it("marks a kind with no attributed usage honestly instead of a bare 0", async () => {
    renderPage("/insights?tab=workflows");
    const wfTable = await screen.findByTestId("sortable-table");
    // "call-to-collateral" has runs (byKind) but no byWorkflowType usage row.
    const row = within(wfTable).getByText("Call To Collateral").closest("tr")!;
    expect(within(row).getAllByText("no usage data").length).toBeGreaterThan(0);
  });

  it("re-sorts the workflow-by-kind table when a column header is clicked", async () => {
    renderPage("/insights?tab=workflows");
    const wfTable = await screen.findByTestId("sortable-table");
    expect(
      within(wfTable).getAllByTestId("sortable-row")[0]!.textContent,
    ).toContain("Call To Collateral");
    const kindHeader = within(wfTable)
      .getAllByTestId("sortable-header")
      .find((b) => b.getAttribute("data-col") === "kind")!;
    fireEvent.click(kindHeader);
    expect(
      within(wfTable).getAllByTestId("sortable-row")[0]!.textContent,
    ).toContain("Mvt Landing Page");
  });

  it("shows the status summary once", async () => {
    renderPage("/insights?tab=workflows");
    await screen.findByText("Workflow runs by status");
  });

  it("filters the workflow-by-kind table by kind", async () => {
    renderPage("/insights?tab=workflows");
    await screen.findByTestId("sortable-table");
    fireEvent.change(screen.getByTestId("kind-filter"), {
      target: { value: "last30days" },
    });
    const wfTable = screen.getByTestId("sortable-table");
    const rows = within(wfTable).getAllByTestId("sortable-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Last30days");
  });

  it("does not show an actor filter, since kind rows aren't actor-scoped", async () => {
    renderPage("/insights?tab=workflows");
    await screen.findByTestId("sortable-table");
    expect(screen.queryByTestId("actor-filter")).toBeNull();
  });
});

describe("InsightsDashboard people tab", () => {
  it("renders a single usage-by-person table marking the caller, with cost", async () => {
    renderPage("/insights?tab=people");
    const personTable = await screen.findByTestId("sortable-table");
    within(personTable).getByText("Sawyer");
    within(personTable).getByText("(me)");
    within(personTable).getByText("Dana");
    const headers = within(personTable)
      .getAllByRole("columnheader")
      .map((th) => th.textContent?.replace(/[▲▼]/g, "").trim());
    expect(headers).toEqual([
      "Person",
      "Chats",
      "Tool calls",
      "Tokens",
      "Cost",
    ]);
    screen.getByText("Excludes shared agents");
  });

  it("navigates to the actor detail page when a person row link is clicked", async () => {
    renderPage("/insights?tab=people");
    const personTable = await screen.findByTestId("sortable-table");
    fireEvent.click(within(personTable).getByText("Dana"));

    await waitFor(() => {
      screen.getByTestId("actor-probe");
    });
    expect(screen.getByTestId("probe-id").textContent).toBe("pri_other");
    expect(screen.getByTestId("probe-name").textContent).toBe("Dana");
  });

  it("filters the usage-by-person table by actor kind", async () => {
    renderPage("/insights?tab=people");
    await screen.findByTestId("sortable-table");
    fireEvent.change(screen.getByTestId("actor-filter"), {
      target: { value: "others" },
    });
    const personTable = screen.getByTestId("sortable-table");
    const rows = within(personTable).getAllByTestId("sortable-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Dana");
    expect(rows[0]!.textContent).not.toContain("Sawyer");
  });

  it("does not show a kind filter, since people rows aren't kind-scoped", async () => {
    renderPage("/insights?tab=people");
    await screen.findByTestId("sortable-table");
    expect(screen.queryByTestId("kind-filter")).toBeNull();
  });

  it("shows per-person token totals with a caveat note when the range crosses the live/history boundary", async () => {
    const original = mockOverview.tokensRecordedFrom;
    mockOverview.tokensRecordedFrom = isoDay(-1);
    try {
      renderPage("/insights?tab=people");
      const personTable = await screen.findByTestId("sortable-table");
      const sawyerRow = within(personTable).getByText("Sawyer").closest("tr");
      expect(sawyerRow?.textContent).toContain("790");
    } finally {
      mockOverview.tokensRecordedFrom = original;
    }
  });
});

describe("InsightsDashboard agents tab", () => {
  it("shows an empty state when the tenant has no agent instances", async () => {
    renderPage("/insights?tab=agents");
    await screen.findByText("No agent instances in this workbench yet.");
  });
});

describe("dashboard data helpers", () => {
  it("resolves preset and custom ranges", () => {
    expect(resolveRange("all", {})).toEqual({});
    expect(resolveRange("custom", {})).toEqual({});
    expect(resolveRange("custom", { startDate: "2026-05-01" })).toEqual({
      startDate: "2026-05-01",
    });
    expect(
      resolveRange("custom", {
        startDate: "2026-05-01",
        endDate: "2026-05-10",
      }),
    ).toEqual({ startDate: "2026-05-01", endDate: "2026-05-10" });
    expect(resolveRange("7d", {}).startDate).toBeDefined();
  });

  it("merges run counts with per-kind usage, zero-filling gaps and marking usage attribution", () => {
    const rows = mergeWorkflowKindRows(
      [
        { key: "deck", count: 5 },
        { key: "brief", count: 2 },
      ],
      [
        {
          kind: "deck",
          turnCount: 50,
          toolCallCount: 15,
          inputTokens: 250,
          outputTokens: 150,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
          cost: null,
        },
        {
          kind: "orphan",
          turnCount: 3,
          toolCallCount: 1,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
          cost: null,
        },
      ],
    );
    const deck = rows.find((r) => r.kind === "deck")!;
    expect(deck.runs).toBe(5);
    expect(deck.turnCount).toBe(50);
    expect(deck.hasUsageData).toBe(true);
    const brief = rows.find((r) => r.kind === "brief")!;
    expect(brief.turnCount).toBe(0);
    expect(brief.hasUsageData).toBe(false);
    const orphan = rows.find((r) => r.kind === "orphan")!;
    expect(orphan.runs).toBe(0);
    expect(orphan.hasUsageData).toBe(true);
  });

  it("filters people by actor kind", () => {
    const people = [
      {
        principalId: "a",
        name: "A",
        isSelf: true,
        turnCount: 1,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        cost: null,
      },
      {
        principalId: "b",
        name: "B",
        isSelf: false,
        turnCount: 1,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        cost: null,
      },
    ];
    expect(filterPeople(people, "me")).toHaveLength(1);
    expect(filterPeople(people, "others")[0]!.principalId).toBe("b");
    expect(filterPeople(people, "all")).toHaveLength(2);
  });
});
