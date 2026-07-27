/// <reference types="bun" />
import "../test-setup";
import { describe, expect, it, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

void mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    activeTenantId: "tnt-1",
    activeWorkbench: { tenantName: "Acme" },
    loading: false,
  }),
}));
void mock.module("./use-model-pricing", () => ({
  useModelPricing: () => ({ data: null, isError: false, isFetched: true }),
}));
const hubApi = await import("../lib/hub-api");
void mock.module("../lib/hub-api", () => ({
  ...hubApi,
  getActivityOverview: () =>
    Promise.resolve({
      workflowRuns: { activeExecutions: 0, byKind: [] },
      byWorkflowType: [],
      byPerson: [],
      byModel: [],
      inference: { summary: {} },
      metricsSeries: [],
      tokensRecordedFrom: null,
    }),
}));

const { useInsightsOverview } = await import("./use-insights-overview");

describe("useInsightsOverview overviewQuery freshness config", () => {
  it("polls the activity overview on a short interval so the KpiRow live pulse reflects near-real-time state (CL-4419)", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useInsightsOverview(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() =>
      expect(result.current.overviewQuery.isSuccess).toBe(true),
    );

    const state = client
      .getQueryCache()
      .findAll()
      .find((entry) => entry.queryKey[0] === "activity-overview");
    expect(state).toBeDefined();
    const options = state?.options as {
      staleTime?: number;
      refetchInterval?: number;
      refetchIntervalInBackground?: boolean;
    };
    expect(options.staleTime).toBe(30_000);
    expect(options.refetchInterval).toBe(30_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });
});
