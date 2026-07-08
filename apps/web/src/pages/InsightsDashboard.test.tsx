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

// The tenant roster section owns its own query lifecycle (covered by
// TenantRoster.test); stub its hook so the dashboard test stays hermetic and
// never reaches for the network.
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
      cost: null,
    },
    {
      kind: "mvt-landing-page",
      turnCount: 2,
      toolCallCount: 1,
      inputTokens: 120,
      outputTokens: 30,
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

describe("InsightsDashboard", () => {
  it("renders turn and tool-call totals from the analytics summary", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("Total chats");
    });
    expect(screen.getAllByText("12").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Tool calls").length).toBeGreaterThanOrEqual(1);
  });

  it("shows success-rate sub-labels for turns and tool calls", async () => {
    renderPage();

    await waitFor(() => {
      screen.getByText("Total chats");
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
    expect(screen.queryByText("Activity trends")).toBeNull();
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
      const modelsCard = screen.getByText("Models · by chats").closest("div")!;
      expect(within(modelsCard).queryByText("deepseek-v4-flash")).toBeNull();
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
    // "Artifacts" / "Workflow runs" now appear both as KPI tiles and in the
    // operational ledger, so assert presence rather than uniqueness.
    expect(screen.getAllByText("Artifacts").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Workflow runs").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("renders workflow runs by kind, merging run counts with per-kind usage", async () => {
    renderPage();

    await screen.findAllByTestId("sortable-table");
    // person table is first, workflow-by-kind second.
    const wfTable = screen.getAllByTestId("sortable-table")[3]!;
    expect(wfTable.textContent).toContain("Call To Collateral");
    expect(wfTable.textContent).toContain("Last30days");
    const row = within(wfTable).getByText("Mvt Landing Page").closest("tr");
    // Tokens = input 120 + output 30 = 150.
    expect(row?.textContent).toContain("150");
    // The removed "By agent" section no longer renders.
    expect(screen.queryByText("By agent")).toBeNull();
  });

  it("re-sorts the workflow-by-kind table when a column header is clicked", async () => {
    renderPage();

    await screen.findAllByTestId("sortable-table");
    const wfTable = screen.getAllByTestId("sortable-table")[3]!;
    // Default sort is runs desc -> Call To Collateral (8 runs) leads.
    expect(
      within(wfTable).getAllByTestId("sortable-row")[0]!.textContent,
    ).toContain("Call To Collateral");
    // Sort by kind ascending-then it toggles; click the kind header.
    const kindHeader = within(wfTable)
      .getAllByTestId("sortable-header")
      .find((b) => b.getAttribute("data-col") === "kind")!;
    fireEvent.click(kindHeader);
    // desc by kind name -> "Mvt Landing Page" first (M > L > C).
    expect(
      within(wfTable).getAllByTestId("sortable-row")[0]!.textContent,
    ).toContain("Mvt Landing Page");
  });

  it("keeps the header preset row wrapping and scrolls wide tables within themselves", async () => {
    renderPage();

    await screen.findAllByTestId("sortable-table");
    // The preset buttons wrap rather than forcing the header past the viewport.
    const presetGroup = screen.getByText("7 days").parentElement;
    expect(presetGroup?.className).toContain("flex-wrap");
    // The sortable table lives inside an overflow-x-auto wrapper so a wide table
    // scrolls itself rather than the page.
    const personTable = screen.getAllByTestId("sortable-table")[2]!;
    expect(personTable.parentElement?.className).toContain("overflow-x-auto");
  });

  it("renders a usage-by-person table marking the caller", async () => {
    renderPage();

    await screen.findAllByTestId("sortable-table");
    const personTable = screen.getAllByTestId("sortable-table")[2]!;
    within(personTable).getByText("Sawyer");
    within(personTable).getByText("(me)");
    within(personTable).getByText("Dana");
    screen.getByText("Excludes shared agents");
  });

  it("navigates to the actor detail page when a person row link is clicked", async () => {
    renderPage();

    await screen.findAllByTestId("sortable-table");
    const personTable = screen.getAllByTestId("sortable-table")[2]!;
    fireEvent.click(within(personTable).getByText("Dana"));

    await waitFor(() => {
      screen.getByTestId("actor-probe");
    });
    expect(screen.getByTestId("probe-id").textContent).toBe("pri_other");
    // The clicked row seeds the detail page with the actor via router state so
    // identity renders instantly before the id-based fetch resolves.
    expect(screen.getByTestId("probe-name").textContent).toBe("Dana");
  });

  it("orders the usage-by-person table by tokens by default", async () => {
    renderPage();

    await screen.findAllByTestId("sortable-table");
    const personTable = screen.getAllByTestId("sortable-table")[2]!;
    const headers = within(personTable)
      .getAllByRole("columnheader")
      .map((th) => th.textContent?.replace(/[▲▼]/g, "").trim());
    expect(headers).toEqual(["Person", "Chats", "Tool calls", "Tokens"]);
    // Default sort is tokens desc: Sawyer (790) before Dana (360).
    const bodyRows = within(personTable).getAllByTestId("sortable-row");
    expect(bodyRows[0]?.textContent).toContain("Sawyer");
    expect(bodyRows[1]?.textContent).toContain("Dana");
  });

  it("shows per-person token totals with a caveat note when the range crosses the live/history boundary", async () => {
    const original = mockOverview.tokensRecordedFrom;
    mockOverview.tokensRecordedFrom = isoDay(-1);
    try {
      renderPage();

      await screen.findAllByTestId("sortable-table");
      const personTable = screen.getAllByTestId("sortable-table")[2]!;
      const sawyerRow = within(personTable).getByText("Sawyer").closest("tr");
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

  it("surfaces a plain-language error when the overview query fails", async () => {
    overviewReject = new Error("overview boom");
    renderPage();
    await screen.findByText(/overview boom/);
  });
});

describe("InsightsDashboard KPIs, charts, and filters", () => {
  it("computes KPI tiles from the loaded range", async () => {
    renderPage();
    await screen.findByText("This range");
    // Total activity = turns (12) + tool calls (4) = 16.
    const kpi = screen.getByText("This range").closest("div")!;
    expect(within(kpi).getByText("Total activity")).toBeDefined();
    expect(within(kpi).getByText("16")).toBeDefined();
    // Workflow runs KPI uses executionsStartedInRange (3), not all-time executionRecords (8).
    const workflowRunsTile = within(kpi)
      .getByText("Workflow runs")
      .closest("div");
    expect(workflowRunsTile).toBeDefined();
    expect(within(workflowRunsTile!).getByText("3")).toBeDefined();
    // Active actors = attributed people (2).
    expect(within(kpi).getByText("Active actors")).toBeDefined();
  });

  it("renders charts with visually-hidden table fallbacks for a11y", async () => {
    renderPage();
    await waitFor(() => {
      expect(
        screen.getAllByTestId("time-series-chart").length,
      ).toBeGreaterThanOrEqual(1);
    });
    // Time-series a11y fallback table lists every daily bucket.
    expect(
      screen.getAllByTestId("time-series-table").length,
    ).toBeGreaterThanOrEqual(1);
    // Category-bar charts (runs-by-kind, top actors) each ship a table fallback.
    expect(
      screen.getAllByTestId("category-bar-table").length,
    ).toBeGreaterThanOrEqual(1);
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

  it("filters the usage-by-person table by actor kind", async () => {
    renderPage();
    await screen.findAllByTestId("sortable-table");
    fireEvent.change(screen.getByTestId("actor-filter"), {
      target: { value: "others" },
    });
    const personTable = screen.getAllByTestId("sortable-table")[2]!;
    const rows = within(personTable).getAllByTestId("sortable-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Dana");
    expect(rows[0]!.textContent).not.toContain("Sawyer");
  });

  it("filters the workflow-by-kind table by kind", async () => {
    renderPage();
    await screen.findAllByTestId("sortable-table");
    fireEvent.change(screen.getByTestId("kind-filter"), {
      target: { value: "last30days" },
    });
    const wfTable = screen.getAllByTestId("sortable-table")[3]!;
    const rows = within(wfTable).getAllByTestId("sortable-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Last30days");
  });

  it("flags failed turns with the semantic danger token, not the action accent", async () => {
    const priorFailed = mockOverview.inference.summary.failedTurnCount;
    mockOverview.inference.summary.failedTurnCount = 2;
    try {
      renderPage();
      const label = await screen.findByText("Total chats");
      const tile = label.closest("div")!;
      const value = within(tile).getByText("12");
      expect(value.className).toContain("text-red");
      expect(value.className).not.toContain("text-accent");
    } finally {
      mockOverview.inference.summary.failedTurnCount = priorFailed;
    }
  });
});

describe("dashboard data helpers", () => {
  it("resolves preset and custom ranges", () => {
    expect(resolveRange("all", {})).toEqual({});
    // custom with no start date falls back to all-time
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

  it("merges run counts with per-kind usage, zero-filling gaps", () => {
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
          cost: null,
        },
        {
          kind: "orphan",
          turnCount: 3,
          toolCallCount: 1,
          inputTokens: 10,
          outputTokens: 5,
          cost: null,
        },
      ],
    );
    const deck = rows.find((r) => r.kind === "deck")!;
    expect(deck.runs).toBe(5);
    expect(deck.turnCount).toBe(50);
    // brief has runs but no usage -> usage zero-filled
    expect(rows.find((r) => r.kind === "brief")!.turnCount).toBe(0);
    // orphan has usage but no runs -> runs zero-filled, still present
    expect(rows.find((r) => r.kind === "orphan")!.runs).toBe(0);
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
