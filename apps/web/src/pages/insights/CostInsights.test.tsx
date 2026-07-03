/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

type Row = {
  agentId: string;
  agentName: string | null;
  inferenceCalls: number;
  cacheMissCalls: number;
  cacheHitCalls: number;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissRate: number;
  cacheAbsorptionRatio: number;
};

let baselineRows: Row[] = [];
let baselineError: Error | null = null;
let baselineCalls: {
  tenantId: string;
  startDate?: string;
  endDate?: string;
}[] = [];

mock.module("@workbench/client", () => ({
  getCacheBaseline: (
    _options: unknown,
    params: { tenantId: string; startDate?: string; endDate?: string },
  ) => {
    baselineCalls.push({
      tenantId: params.tenantId,
      ...(params.startDate !== undefined
        ? { startDate: params.startDate }
        : {}),
      ...(params.endDate !== undefined ? { endDate: params.endDate } : {}),
    });
    if (baselineError) return Promise.reject(baselineError);
    return Promise.resolve(baselineRows);
  },
}));

import { CostInsights, aggregateCacheBaseline } from "./CostInsights";

function row(overrides: Partial<Row> = {}): Row {
  return {
    agentId: "agt_myra",
    agentName: "Myra",
    inferenceCalls: 40,
    cacheMissCalls: 8,
    cacheHitCalls: 32,
    sessionCount: 12,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 9000,
    cacheWriteTokens: 300,
    cacheMissRate: 0.2,
    cacheAbsorptionRatio: 0.9,
    ...overrides,
  };
}

const DAILY = [
  {
    date: "2026-06-01",
    turnCount: 0,
    failedTurnCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    inputTokens: 500,
    outputTokens: 250,
    cacheReadTokens: 4500,
    cacheWriteTokens: 150,
    thinkingTokens: 0,
  },
];

function renderCost(tenantId = "t1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CostInsights
          tenantId={tenantId}
          dailySeries={DAILY}
          range={{ startDate: "2026-06-01", endDate: "2026-06-30" }}
          tokenCaveat={null}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  baselineRows = [];
  baselineError = null;
  baselineCalls = [];
});

afterEach(() => {
  cleanup();
});

describe("aggregateCacheBaseline", () => {
  it("sums the split and derives promptTokens + absorption across agents", () => {
    const rollup = aggregateCacheBaseline([
      row(),
      row({
        agentId: "agt_oat",
        inputTokens: 1000,
        cacheReadTokens: 0,
        outputTokens: 200,
        cacheWriteTokens: 100,
        sessionCount: 3,
        inferenceCalls: 10,
      }),
    ]);
    expect(rollup.inputTokens).toBe(2000);
    expect(rollup.cacheReadTokens).toBe(9000);
    expect(rollup.promptTokens).toBe(11000);
    // cacheRead 9000 / prompt 11000
    expect(rollup.cacheAbsorptionRatio).toBeCloseTo(9000 / 11000, 5);
    expect(rollup.inferenceCalls).toBe(50);
    expect(rollup.sessionCount).toBe(15);
  });

  it("reports zero absorption when there are no prompt tokens", () => {
    const rollup = aggregateCacheBaseline([
      row({ inputTokens: 0, cacheReadTokens: 0 }),
    ]);
    expect(rollup.cacheAbsorptionRatio).toBe(0);
  });
});

describe("CostInsights", () => {
  it("renders the cache-read/write/output split and per-agent rollup from the query", async () => {
    baselineRows = [row(), row({ agentId: "agt_oat", agentName: "Oat" })];
    renderCost();

    await waitFor(() => {
      screen.getByTestId("category-bar-chart");
    });

    // The billed-class split is visible with each cache class as its own bar.
    const labels = screen
      .getAllByTestId("category-bar")
      .map((bar) => bar.getAttribute("data-label"));
    expect(labels).toEqual(
      expect.arrayContaining([
        "Cache read",
        "Cache write",
        "Output",
        "Fresh input",
      ]),
    );

    // Per-agent rollup lists both agents.
    screen.getByText("Myra");
    screen.getByText("Oat");

    // Gated query fired once with the forwarded range.
    await waitFor(() => expect(baselineCalls.length).toBe(1));
    expect(baselineCalls[0]).toEqual({
      tenantId: "t1",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
  });

  it("exposes a visually-hidden data table so the split is legible without color", async () => {
    baselineRows = [row()];
    renderCost();

    await waitFor(() => {
      screen.getByTestId("category-bar-table");
    });
    const fallback = screen.getByTestId("category-bar-table");
    expect(fallback.className).toContain("sr-only");
    within(fallback).getByText("Cache read");
  });

  it("does not query when there is no active tenant", () => {
    renderCost("");
    expect(baselineCalls.length).toBe(0);
  });

  it("shows an empty state when no inference is recorded", async () => {
    baselineRows = [];
    renderCost();
    await waitFor(() => {
      screen.getByText(/No inference cost recorded/);
    });
  });

  it("renders the over-time chart whenever dailySeries has data, even when the cache-baseline is empty", async () => {
    baselineRows = [];
    renderCost();
    // dailySeries (DAILY) has data → the over-time chart is present…
    await waitFor(() => {
      screen.getByTestId("time-series-chart");
    });
    // …while the cache-baseline-derived content is still in its empty state.
    screen.getByText(/No inference cost recorded/);
  });

  it("does not render the over-time chart when dailySeries is empty", () => {
    baselineRows = [row()];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CostInsights
            tenantId="t1"
            dailySeries={[]}
            range={{ startDate: "2026-06-01", endDate: "2026-06-30" }}
            tokenCaveat={null}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("time-series-chart")).toBeNull();
  });

  it("warns that the split total includes cache-write and excludes thinking tokens", () => {
    baselineRows = [row()];
    renderCost();
    screen.getByText(/includes cache-write tokens/i);
    screen.getByText(/Thinking and reasoning tokens are excluded/i);
    screen.getByText(/token share, not a cost saving/i);
  });

  it("shows a legible error when the query fails", async () => {
    baselineError = new Error("HTTP 500");
    renderCost();
    await waitFor(() => {
      screen.getByText(/Couldn’t load cost data/);
    });
  });
});
