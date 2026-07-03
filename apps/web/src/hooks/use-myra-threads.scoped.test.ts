/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

let activeTenantId: string | null = "tnt_child";
mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({ activeTenantId }),
}));

const {
  useMyraThreads,
  useCreateMyraThread,
  useRenameMyraThread,
  useDeleteMyraThread,
  useGenerateMyraThreadTitle,
} = await import("./use-myra-threads");

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const originalFetch = globalThis.fetch;

function stubFetch(body: unknown): void {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
    } as unknown as Response);
  }) as typeof fetch;
}

function stubDeferredFetch(body: unknown): { resolve: () => void } {
  let resolveResponse: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    resolveResponse = resolve;
  });
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return gate.then(
      () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve(body),
        }) as unknown as Response,
    );
  }) as typeof fetch;
  return { resolve: resolveResponse };
}

const thread = {
  id: "map-1",
  instanceId: "inst-1",
  label: "Chat",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function wrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, Wrapper };
}

beforeEach(() => {
  activeTenantId = "tnt_child";
  calls.length = 0;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("useMyraThreads (tenant scoping)", () => {
  it("fetches the active tenant's threads and keys the query by tenant", async () => {
    stubFetch({ threads: [thread] });
    const { client, Wrapper } = wrapper();
    renderHook(() => useMyraThreads(), { wrapper: Wrapper });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toContain(
      "/api/v1/tenants/tnt_child/me/myra/threads",
    );
    const keys = client
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey);
    expect(keys).toContainEqual(["myra-threads", "tnt_child"]);
  });

  it("does not fetch when there is no active tenant", async () => {
    activeTenantId = null;
    stubFetch({ threads: [] });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useMyraThreads(), {
      wrapper: Wrapper,
    });
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("Myra thread mutations (tenant scoping)", () => {
  it("creates a thread in the active tenant", async () => {
    stubFetch({ thread, created: true });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useCreateMyraThread(), {
      wrapper: Wrapper,
    });
    act(() => {
      result.current.mutate("Pricing");
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain(
      "/api/v1/tenants/tnt_child/me/myra/threads",
    );
    expect(calls[0]?.body).toEqual({ label: "Pricing" });
  });

  it("adds a newly created thread to the current cache before caller success handlers run", async () => {
    stubFetch({ thread, created: true });
    const { client, Wrapper } = wrapper();
    client.setQueryData(
      ["myra-threads", "tnt_child"],
      [
        {
          id: "old-1",
          instanceId: "inst-old",
          label: "Old chat",
          createdAt: "2025-12-31T00:00:00.000Z",
        },
      ],
    );
    const { result } = renderHook(() => useCreateMyraThread(), {
      wrapper: Wrapper,
    });

    let cachedBeforeCallerNavigate: unknown;
    act(() => {
      result.current.mutate("Pricing", {
        onSuccess: () => {
          cachedBeforeCallerNavigate = client.getQueryData([
            "myra-threads",
            "tnt_child",
          ]);
        },
      });
    });

    await waitFor(() => expect(cachedBeforeCallerNavigate).toBeDefined());
    expect(cachedBeforeCallerNavigate).toContainEqual(thread);
  });

  it("shares an in-flight create for duplicate empty-chat requests", async () => {
    const deferred = stubDeferredFetch({ thread, created: true });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useCreateMyraThread(), {
      wrapper: Wrapper,
    });

    const creates = [
      result.current.mutateAsync(undefined),
      result.current.mutateAsync(undefined),
    ];
    await waitFor(() => expect(calls).toHaveLength(1));
    deferred.resolve();
    const created = await Promise.all(creates);

    expect(created).toEqual([thread, thread]);
  });

  it("renames a thread in the active tenant", async () => {
    stubFetch({ thread: { ...thread, label: "Renamed" } });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useRenameMyraThread(), {
      wrapper: Wrapper,
    });
    act(() => {
      result.current.mutate({ id: "map-1", label: "Renamed" });
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toContain(
      "/api/v1/tenants/tnt_child/me/myra/threads/map-1",
    );
  });

  it("deletes a thread in the active tenant", async () => {
    stubFetch({ deleted: true });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useDeleteMyraThread(), {
      wrapper: Wrapper,
    });
    act(() => {
      result.current.mutate("map-1");
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain(
      "/api/v1/tenants/tnt_child/me/myra/threads/map-1",
    );
  });

  it("titles a thread in the active tenant", async () => {
    stubFetch({ thread: { ...thread, label: "Titled" } });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useGenerateMyraThreadTitle(), {
      wrapper: Wrapper,
    });
    act(() => {
      result.current.mutate({ id: "map-1", firstMessage: "Hi there" });
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain(
      "/api/v1/tenants/tnt_child/me/myra/threads/map-1/title",
    );
    expect(calls[0]?.body).toEqual({ firstMessage: "Hi there" });
  });
});
