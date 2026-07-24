/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

mock.module("@workbench/client", () => ({
  getTenantRoster: () => Promise.resolve({ agents: [], recentRuns: [] }),
}));

const { useTenantRoster } = await import("./use-tenant-roster");

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
});

describe("useTenantRoster", () => {
  it("polls on a short interval so the live-pulse indicator reflects near-real-time state (CL-4419)", async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useTenantRoster("tenant-1"), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const state = client.getQueryCache().find({
      queryKey: ["tenant-roster", "tenant-1"],
    });
    expect(state).toBeDefined();
    const options = state?.options as {
      staleTime?: number;
      refetchInterval?: number;
      refetchIntervalInBackground?: boolean;
    };
    expect(options.staleTime).toBe(20_000);
    expect(options.refetchInterval).toBe(20_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  it("stays disabled and skips the poll when tenantId is empty", () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useTenantRoster(""), {
      wrapper: wrapper(client),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.isPending).toBe(true);
  });
});
