/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { listArtifacts } from "../../../../packages/client/src/index";
import { useArtifacts } from "../../../../packages/client/src/react";

afterEach(cleanup);

describe("@workbench/client artifacts", () => {
  it("passes tenantId as a query parameter when provided", async () => {
    const fetchMock = mock(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({ artifacts: [], nextCursor: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    const fetcher: typeof fetch = Object.assign(
      (url: string | URL | Request, init?: RequestInit) => fetchMock(url, init),
      { preconnect: mock(() => {}) },
    );

    await listArtifacts(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { tenantId: "tenant-workbench" },
    );

    const url = fetchMock.mock.calls[0]?.[0];
    expect(url).toBe(
      "http://localhost:4000/api/v1/artifacts?tenantId=tenant-workbench",
    );
  });

  it("includes tenantId in the artifacts query key", async () => {
    // Use a real QueryClient (rather than module-mocking @tanstack/react-query,
    // which leaks globally under bun and poisons every later test that renders a
    // real query). Read the registered queryKey back from the cache.
    const fetchMock = mock<
      (url?: unknown, init?: unknown) => Promise<Response>
    >(() =>
      Promise.resolve(
        new Response(JSON.stringify({ artifacts: [] }), { status: 200 }),
      ),
    );
    const fetcher: typeof fetch = Object.assign(
      (url: string | URL | Request, init?: RequestInit) => fetchMock(url, init),
      { preconnect: mock(() => {}) },
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderHook(
      () =>
        useArtifacts(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: "tenant-workbench" },
        ),
      {
        wrapper: ({ children }) =>
          React.createElement(QueryClientProvider, { client }, children),
      },
    );

    await waitFor(() => {
      expect(client.getQueryCache().getAll().length).toBeGreaterThan(0);
    });
    const queryKey = client.getQueryCache().getAll()[0]?.queryKey as unknown[];
    expect(queryKey[0]).toBe("artifacts");
    expect(queryKey[1]).toBe("tenant-workbench");
  });
});
