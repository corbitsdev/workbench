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

type PrincipalAnalytics = {
  tools: { name: string; calls: number; errors: number }[];
  cost: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    thinkingTokens: number;
    inferenceCalls: number;
    toolCalls: number;
  };
};

const ZERO_COST: PrincipalAnalytics["cost"] = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  thinkingTokens: 0,
  inferenceCalls: 0,
  toolCalls: 0,
};

let result: PrincipalAnalytics | null = null;
let error: Error | null = null;
let hang = false;

mock.module("@workbench/client", () => ({
  getPrincipalAnalytics: () => {
    if (hang) return new Promise<PrincipalAnalytics>(() => {});
    if (error) return Promise.reject(error);
    return Promise.resolve(result ?? { tools: [], cost: ZERO_COST });
  },
  // principal-facets pulls in RosterFacet, which imports getPrincipalRoster;
  // the named export must exist on the mocked module or the import fails.
  getPrincipalRoster: () => Promise.resolve({ instances: [], runs: [] }),
}));

const { ToolsFacet, CostFacet } = await import("./principal-facets");

function renderFacet(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  result = null;
  error = null;
  hang = false;
});
afterEach(() => cleanup());

describe("ToolsFacet", () => {
  it("renders per-tool call counts from the analytics endpoint", async () => {
    result = {
      tools: [
        { name: "attio__list_objects", calls: 5, errors: 1 },
        { name: "granola__get", calls: 2, errors: 0 },
      ],
      cost: ZERO_COST,
    };
    renderFacet(<ToolsFacet tenantId="t1" principalId="prn_1" />);
    const facet = await waitFor(() => screen.getByTestId("facet-tools"));
    expect(facet.textContent).toContain("attio__list_objects");
    screen.getByText("5");
    screen.getByText("2");
  });

  it("shows a loading state before data resolves", () => {
    hang = true;
    renderFacet(<ToolsFacet tenantId="t1" principalId="prn_1" />);
    expect(screen.getByTestId("tools-loading")).toBeTruthy();
  });

  it("shows an honest empty state with no fabricated rows", async () => {
    result = { tools: [], cost: ZERO_COST };
    renderFacet(<ToolsFacet tenantId="t1" principalId="prn_1" />);
    await screen.findByText("No tool calls recorded for this principal.");
  });

  it("surfaces a legible error with a retry", async () => {
    error = new Error("boom");
    renderFacet(<ToolsFacet tenantId="t1" principalId="prn_1" />);
    await waitFor(() =>
      screen.getByText(/Couldn.t load this principal.s tool activity/),
    );
    screen.getByText("Retry");
  });
});

describe("CostFacet", () => {
  it("renders real token-class totals, not 'not recorded yet'", async () => {
    result = {
      tools: [],
      cost: {
        ...ZERO_COST,
        inputTokens: 12345,
        outputTokens: 678,
        cacheReadTokens: 90,
        inferenceCalls: 3,
      },
    };
    renderFacet(<CostFacet tenantId="t1" principalId="prn_1" label="Myra" />);
    const facet = await waitFor(() => screen.getByTestId("facet-cost"));
    within(facet).getByText("12,345");
    within(facet).getByText("678");
    within(facet).getByText("90");
    // Every canonical class renders, including a zero one, so the reader sees
    // the full breakdown rather than only the non-zero rows.
    within(facet).getByText("Cache write");
    within(facet).getByText("3"); // inference call count
    expect(within(facet).queryByText("not recorded yet")).toBeNull();
  });

  it("shows an honest empty state when no tokens are recorded", async () => {
    result = { tools: [], cost: ZERO_COST };
    renderFacet(<CostFacet tenantId="t1" principalId="prn_1" label="Myra" />);
    await screen.findByText("No token usage recorded for this principal yet.");
  });

  it("shows a loading state before data resolves", () => {
    hang = true;
    renderFacet(<CostFacet tenantId="t1" principalId="prn_1" label="Myra" />);
    expect(screen.getByTestId("cost-loading")).toBeTruthy();
  });

  it("surfaces a legible error with a retry", async () => {
    error = new Error("boom");
    renderFacet(<CostFacet tenantId="t1" principalId="prn_1" label="Myra" />);
    await waitFor(() =>
      screen.getByText(/Couldn.t load this principal.s cost/),
    );
    screen.getByText("Retry");
  });
});
