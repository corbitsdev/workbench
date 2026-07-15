/// <reference types="bun" />
import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
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
  getActivityOverview: () => new Promise(() => {}),
}));

const { useInsightsOverview } = await import("./use-insights-overview");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useInsightsOverview referential stability", () => {
  // exportCsv feeds a useMemo dep array in page chrome (the app top bar); an
  // identity that churns per render defeats that memo and turns the chrome
  // publish effect into an unbounded update loop.
  it("keeps exportCsv identity stable across re-renders", () => {
    const hook = renderHook(() => useInsightsOverview(), { wrapper });
    const first = hook.result.current.exportCsv;
    act(() => {
      hook.rerender();
    });
    expect(hook.result.current.exportCsv).toBe(first);
  });

  it("changes exportCsv only when its inputs change", () => {
    const hook = renderHook(() => useInsightsOverview(), { wrapper });
    const first = hook.result.current.exportCsv;
    act(() => {
      hook.result.current.setExportBucket("week");
    });
    expect(hook.result.current.exportBucket).toBe("week");
    expect(hook.result.current.exportCsv).not.toBe(first);
  });
});
