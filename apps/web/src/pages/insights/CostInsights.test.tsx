/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { PriceCatalog } from "@workbench/pricing";
import type { ActivityOverview } from "../../lib/hub-api";
import { resolveTenantPricedByModel } from "./metrics";
import { CostInsights } from "./CostInsights";

function catalog(models: PriceCatalog["models"] = {}): PriceCatalog {
  return {
    source: "models.dev",
    generatedAt: "2026-06-01T00:00:00Z",
    models,
    qualified: {},
    ambiguous: [],
  };
}

function overview(overrides: Partial<ActivityOverview> = {}): ActivityOverview {
  return {
    tenantId: "t1",
    range: {},
    artifacts: { total: 0, createdInRange: 0, byStatus: [], byKind: [] },
    workflowRuns: {
      executionRecords: 0,
      executionsStartedInRange: 0,
      activeExecutions: 0,
      byStatus: [],
      byKind: [],
      deploymentsIndexed: 0,
    },
    agentInstances: { active: 0, startedInRange: 0, endedInRange: 0, total: 0 },
    agentActivity: { active: 0, idle: 0 },
    conversations: { total: 0, createdInRange: 0 },
    messages: { total: 0, createdInRange: 0 },
    dailySeries: [],
    metricsBucket: "day",
    metricsSeries: [],
    models: [],
    byModel: [],
    pricedByModel: null,
    tokensRecordedFrom: "2000-01-01",
    byPerson: [],
    byWorkflowType: [],
    inference: {
      summary: {
        tenantId: "t1",
        turnCount: 0,
        failedTurnCount: 0,
        toolCallCount: 0,
        toolErrorCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
      },
      previousSummary: null,
      byAgent: [],
      byInstance: [],
    },
    ...overrides,
  };
}

function renderCost(
  data: ActivityOverview,
  opts: {
    tenantId?: string;
    catalog?: PriceCatalog | null;
    pricingUnavailable?: boolean;
    pricingLoading?: boolean;
  } = {},
) {
  const catalog = opts.catalog ?? null;
  const priced = resolveTenantPricedByModel(data, catalog);
  const pricingUnavailable =
    opts.pricingUnavailable ??
    (data.byModel.length > 0 && priced === null && !opts.pricingLoading);
  const pricingLoading = opts.pricingLoading ?? false;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CostInsights
          tenantId={opts.tenantId ?? "t1"}
          overview={data}
          range={{ startDate: "2026-06-01", endDate: "2026-06-30" }}
          tokenCaveat={null}
          priced={priced}
          catalog={catalog}
          pricingUnavailable={pricingUnavailable}
          pricingLoading={pricingLoading}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("CostInsights", () => {
  it("computes total dollar cost from byModel usage against a known rate catalog", async () => {
    const cat = catalog({
      "deepseek-v4-flash": {
        modelId: "deepseek-v4-flash",
        provider: "opencode-zen",
        providerName: "OpenCode Zen",
        input: 1,
        output: 2,
        cacheRead: 0.5,
        cacheWrite: 1.5,
      },
    });
    const data = overview({
      byModel: [
        {
          model: "deepseek-v4-flash",
          turnCount: 5,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 2_000_000,
          cacheWriteTokens: 100_000,
          thinkingTokens: 0,
        },
      ],
    });
    renderCost(data, { catalog: cat, pricingUnavailable: false });

    // input: 1*1 = 1, output: 2*0.5=1, cacheRead: 0.5*2=1, cacheWrite: 1.5*0.1=0.15 -> total 3.15
    await waitFor(() => {
      expect(screen.getAllByText("$3.15").length).toBeGreaterThan(0);
    });
    screen.getByText("Total cost");
  });

  it("renders every token class as a separate column in the by-model table", async () => {
    const cat = catalog({});
    const data = overview({
      byModel: [
        {
          model: "kimi",
          turnCount: 1,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
          thinkingTokens: 0,
        },
      ],
    });
    renderCost(data, { catalog: cat, pricingUnavailable: true });

    await waitFor(() => screen.getByText("kimi"));
    const row = screen.getByText("kimi").closest("tr")!;
    expect(row.textContent).toContain("10");
    expect(row.textContent).toContain("20");
    expect(row.textContent).toContain("30");
    expect(row.textContent).toContain("40");
  });

  it("shows a no-rate chip and never fabricates a dollar figure for an unpriced model", async () => {
    const cat = catalog({
      "some-other-model": {
        modelId: "some-other-model",
        provider: "anthropic",
        providerName: "Anthropic",
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
    });
    const data = overview({
      byModel: [
        {
          model: "unknown-model",
          turnCount: 1,
          inputTokens: 100,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
        },
      ],
    });
    renderCost(data, { catalog: cat, pricingUnavailable: false });

    await waitFor(() => screen.getByText("no rate"));
    screen.getByText("Unpriced models");
  });

  it("falls back to a token-only layout with no dollar figures when pricing is unavailable", async () => {
    const data = overview({
      byModel: [
        {
          model: "kimi",
          turnCount: 1,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
        },
      ],
    });
    renderCost(data, {
      catalog: null,
      pricingUnavailable: true,
      pricingLoading: false,
    });

    await waitFor(() => {
      screen.getByText(/Model pricing unavailable/);
    });
    expect(screen.queryByText("Total cost")).toBeNull();
    expect(screen.queryByText(/^\$/)).toBeNull();
  });

  it("shows the hub-computed per-actor dollar cost (CL-2723)", async () => {
    const data = overview({
      byPerson: [
        {
          principalId: "pri_1",
          name: "Sawyer",
          isSelf: true,
          turnCount: 1,
          toolCallCount: 0,
          inputTokens: 5,
          outputTokens: 6,
          cacheReadTokens: 7,
          cacheWriteTokens: 8,
          thinkingTokens: 0,
          cost: {
            cost: {
              input: 1.5,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              thinking: 0,
              total: 1.5,
            },
            unpricedModels: [],
            hasUnpriced: false,
          },
        },
      ],
    });
    renderCost(data, { catalog: catalog({}), pricingUnavailable: true });

    await waitFor(() => screen.getByText("Sawyer"));
    const row = screen.getByText("Sawyer").closest("tr")!;
    expect(row.textContent).toContain("$1.50");
    expect(row.textContent).toContain("5");
    expect(row.textContent).toContain("6");
    expect(row.textContent).toContain("7");
    expect(row.textContent).toContain("8");
    screen.getByText(/priced per model, per person/);
  });

  it("shows an explicit not-priced state for a person with no cost computed", async () => {
    const data = overview({
      byPerson: [
        {
          principalId: "pri_2",
          name: "Dana",
          isSelf: false,
          turnCount: 1,
          toolCallCount: 0,
          inputTokens: 5,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
          cost: null,
        },
      ],
    });
    renderCost(data, { catalog: catalog({}), pricingUnavailable: true });

    await waitFor(() => screen.getByText("Dana"));
    const row = screen.getByText("Dana").closest("tr")!;
    expect(row.textContent).not.toContain("$");
    screen.getByText("not priced");
  });

  it("shows not-priced (never $0.00) when all of a person's usage is unpriced (CL-2723)", async () => {
    const data = overview({
      byPerson: [
        {
          principalId: "pri_3",
          name: "Robin",
          isSelf: false,
          turnCount: 1,
          toolCallCount: 0,
          inputTokens: 2_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
          cost: {
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              thinking: 0,
              total: 0,
            },
            unpricedModels: ["(unknown model)"],
            hasUnpriced: true,
          },
        },
      ],
    });
    renderCost(data, { catalog: catalog({}), pricingUnavailable: true });

    await waitFor(() => screen.getByText("Robin"));
    const row = screen.getByText("Robin").closest("tr")!;
    expect(row.textContent).not.toContain("$");
    expect(row.textContent).toContain("not priced");
  });

  it("renders the over-time class series chart when dailySeries has data", async () => {
    const data = overview({
      dailySeries: [
        {
          date: "2026-06-01",
          turnCount: 1,
          failedTurnCount: 0,
          toolCallCount: 0,
          toolErrorCount: 0,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
          thinkingTokens: 0,
        },
      ],
    });
    renderCost(data, { catalog: catalog({}), pricingUnavailable: true });

    await waitFor(() => {
      screen.getByTestId("time-series-chart");
    });
  });

  it("does not render the over-time chart when dailySeries is empty", () => {
    const data = overview();
    renderCost(data, { catalog: catalog({}), pricingUnavailable: true });
    expect(screen.queryByTestId("time-series-chart")).toBeNull();
  });

  it("shows an empty state for the by-model table when there is no usage", async () => {
    renderCost(overview(), { catalog: catalog({}), pricingUnavailable: true });
    await waitFor(() => {
      screen.getByText("No model usage for this range");
    });
  });

  it("shows a loading state for pricing before the catalog resolves", () => {
    renderCost(overview(), { catalog: null, pricingLoading: true });
    screen.getByTestId("cost-insights-pricing-loading");
  });
});
