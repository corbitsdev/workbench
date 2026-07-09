/// <reference types="bun" />
// Behavioral contract tests for the React surface. These exercise the hooks
// against a real QueryClient with fetch mocked only at the boundary, pinning the
// query-key shape, the enabled-gating contract, and that successful data and
// propagated errors surface to consumers.
import "./test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import type { ArtifactWithSession, WorkflowSummary } from "@workbench/shared";
import {
  artifactsInfiniteQueryKey,
  artifactsListQueryKey,
  useArchiveArtifact,
  useArtifact,
  useArtifacts,
  useArtifactsInfinite,
  useLibraryResources,
  useUnarchiveArtifact,
} from "./react";

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(impl: (...args: FetchArgs) => Promise<Response>) {
  const spy = mock(impl);
  const fetcher = Object.assign(
    (input: FetchArgs[0], init?: FetchArgs[1]) => spy(input, init),
    {
      preconnect: mock(() => {}),
    },
  ) as unknown as typeof fetch;
  return { spy, fetcher };
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const fakeWorkflow: WorkflowSummary = {
  id: "wf-1",
  kind: "collateral-generation",
  status: "running",
  createdAt: new Date().toISOString(),
};

const fakeArtifact: ArtifactWithSession = {
  id: "art-1",
  parentId: null,
  kind: "email",
  title: "Title",
  content: "Body",
  status: "draft",
  version: 1,
  ownerPrincipalId: null,
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: { origin: "workflow" },
  sessionName: "Acme call",
  sessionStatus: "reviewing",
  ownerName: null,
};

afterEach(cleanup);

describe("useLibraryResources", () => {
  it("keys the query by tenantId so different tenants do not share a cache entry", () => {
    const { fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));
    const client = newClient();

    renderHook(
      () =>
        useLibraryResources(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: "tn-1" },
        ),
      { wrapper: wrapper(client) },
    );

    expect(
      client.getQueryCache().findAll({ queryKey: ["workflows", "tn-1"] })
        .length,
    ).toBe(1);
  });

  it("stays disabled and does not fetch when tenantId is null", async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    const { result } = renderHook(
      () =>
        useLibraryResources(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: null },
        ),
      { wrapper: wrapper(newClient()) },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetches workflows for the tenant and surfaces the mapped data on success", async () => {
    const runRow = {
      deploymentId: fakeWorkflow.id,
      kind: fakeWorkflow.kind,
      status: fakeWorkflow.status,
      createdAt: fakeWorkflow.createdAt,
    };
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse([runRow])),
    );

    const { result } = renderHook(
      () =>
        useLibraryResources(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: "tn-1" },
        ),
      { wrapper: wrapper(newClient()) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([fakeWorkflow]);
    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/workflow-runs?tenantId=tn-1",
    );
  });

  it("surfaces a propagated server error to the consumer", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ error: "forbidden" }, 403)),
    );

    const { result } = renderHook(
      () =>
        useLibraryResources(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: "tn-1" },
        ),
      { wrapper: wrapper(newClient()) },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe("forbidden");
  });
});

describe("useArtifacts", () => {
  it("keys the query by tenantId under the artifacts namespace", () => {
    const { fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));
    const client = newClient();

    renderHook(
      () =>
        useArtifacts(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: "tn-9" },
        ),
      { wrapper: wrapper(client) },
    );

    expect(
      client.getQueryCache().findAll({ queryKey: ["artifacts", "tn-9"] })
        .length,
    ).toBe(1);
  });

  it("stays disabled and does not fetch when tenantId is null", () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    const { result } = renderHook(
      () =>
        useArtifacts(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: null },
        ),
      { wrapper: wrapper(newClient()) },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetches artifacts for the tenant and surfaces the data on success", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse({ artifacts: [fakeArtifact], nextCursor: null }),
      ),
    );

    const { result } = renderHook(
      () =>
        useArtifacts(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: "tn-1" },
        ),
      { wrapper: wrapper(newClient()) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([fakeArtifact]);
    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/artifacts?tenantId=tn-1",
    );
  });
});

describe("useArtifactsInfinite", () => {
  it("loads the next cursor page when fetchNextPage is called", async () => {
    const page1 = {
      artifacts: [{ ...fakeArtifact, id: "a-1" }],
      nextCursor: "2024-01-02T00:00:00.000Z__a-1",
    };
    const page2 = {
      artifacts: [{ ...fakeArtifact, id: "a-2", title: "Second page" }],
      nextCursor: null,
    };
    let call = 0;
    const { spy, fetcher } = makeFetch(() => {
      call += 1;
      return Promise.resolve(jsonResponse(call === 1 ? page1 : page2));
    });

    const { result } = renderHook(
      () =>
        useArtifactsInfinite(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: "tn-1" },
        ),
      { wrapper: wrapper(newClient()) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.artifacts).toHaveLength(1);
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();

    await waitFor(() => expect(result.current.artifacts).toHaveLength(2));
    expect(result.current.artifacts[1]?.title).toBe("Second page");
    expect(result.current.hasNextPage).toBe(false);
    expect(spy.mock.calls[1]?.[0]).toContain("cursor=");
  });

  it("uses a distinct infinite query key with the same filter segments", () => {
    const list = artifactsListQueryKey({ tenantId: "tn-9", sort: "oldest" });
    const infinite = artifactsInfiniteQueryKey({
      tenantId: "tn-9",
      sort: "oldest",
    });
    expect(infinite.slice(0, list.length)).toEqual([...list]);
    expect(infinite[infinite.length - 1]).toBe("infinite");
  });

  it("does not share a TanStack cache entry with useArtifacts", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse({ artifacts: [fakeArtifact], nextCursor: null }),
      ),
    );
    const client = newClient();

    renderHook(
      () =>
        useArtifacts(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: "tn-1" },
        ),
      { wrapper: wrapper(client) },
    );
    renderHook(
      () =>
        useArtifactsInfinite(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: "tn-1" },
        ),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => {
      expect(
        client.getQueryCache().findAll({ queryKey: ["artifacts", "tn-1"] }),
      ).toHaveLength(2);
    });
  });
});

describe("useArtifact", () => {
  it("loads one artifact by id under the detail query key", async () => {
    const { fetcher } = makeFetch((input) => {
      const url = String(input);
      if (url.includes("/artifacts/art-detail")) {
        return Promise.resolve(
          jsonResponse({
            artifact: {
              id: "art-detail",
              parentId: null,
              kind: "one-pager",
              title: "Detail",
              content: "x",
              source: { origin: "unknown" },
              status: "draft",
              version: 1,
              ownerPrincipalId: null,
              archivedAt: null,
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              sessionName: null,
              sessionStatus: null,
              ownerName: null,
            },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      );
    });
    const client = newClient();

    const { result } = renderHook(
      () =>
        useArtifact(
          { baseUrl: "http://localhost:4000", fetch: fetcher },
          { tenantId: "tenant-1", artifactId: "art-detail" },
        ),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.title).toBe("Detail");
    expect(result.current.data?.id).toBe("art-detail");
  });
});

describe("artifactsListQueryKey archived segment", () => {
  it("keys the Archived view separately from the default view", () => {
    const defaultKey = artifactsListQueryKey({ tenantId: "tn-9" });
    const archivedKey = artifactsListQueryKey({
      tenantId: "tn-9",
      archived: true,
    });
    expect(archivedKey).not.toEqual([...defaultKey]);
    expect(defaultKey[defaultKey.length - 1]).toBe(false);
    expect(archivedKey[archivedKey.length - 1]).toBe(true);
  });
});

describe("useArchiveArtifact / useUnarchiveArtifact", () => {
  const archivedRow: ArtifactWithSession = {
    id: "art-9",
    parentId: null,
    kind: "one-pager",
    title: "T",
    content: "body",
    source: { origin: "unknown" },
    status: "draft",
    version: 1,
    ownerPrincipalId: "prn-1",
    archivedAt: "2026-07-09T12:00:00.000Z",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    sessionName: null,
    sessionStatus: null,
    ownerName: null,
  };

  it("POSTs the archive route and invalidates the artifacts prefix once (covers detail)", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ artifact: archivedRow })),
    );
    const client = newClient();
    const invalidateSpy = mock(
      client.invalidateQueries.bind(client),
    ) as unknown as typeof client.invalidateQueries;
    client.invalidateQueries = invalidateSpy;

    const { result } = renderHook(
      () =>
        useArchiveArtifact({
          baseUrl: "http://localhost:4000",
          fetch: fetcher,
        }),
      { wrapper: wrapper(client) },
    );
    await result.current.mutateAsync({
      artifactId: "art-9",
      tenantId: "tenant-1",
    });

    expect(spy.mock.calls[0]?.[0]).toContain("/artifacts/art-9/archive");
    expect(spy.mock.calls[0]?.[1]?.method).toBe("POST");
    const keys = (
      invalidateSpy as unknown as {
        mock: { calls: [{ queryKey?: unknown }][] };
      }
    ).mock.calls.map((c) => c[0]?.queryKey);
    // A single ["artifacts"] invalidation is enough — it prefix-matches every
    // ["artifacts", "detail", ...] entry, so no separate detail invalidation.
    expect(keys).toEqual([["artifacts"]]);
  });

  it("POSTs the unarchive route", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse({ artifact: { ...archivedRow, archivedAt: null } }),
      ),
    );
    const client = newClient();
    const { result } = renderHook(
      () =>
        useUnarchiveArtifact({
          baseUrl: "http://localhost:4000",
          fetch: fetcher,
        }),
      { wrapper: wrapper(client) },
    );
    const updated = await result.current.mutateAsync({ artifactId: "art-9" });
    expect(spy.mock.calls[0]?.[0]).toContain("/artifacts/art-9/unarchive");
    expect(updated.archivedAt).toBeNull();
  });
});
