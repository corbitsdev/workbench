/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useTaskPush } from "./use-task-push";
import { useTasks } from "./use-tasks";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("useTaskPush", () => {
  it("stays pending until the invalidated tasks refetch (triggered by an active useTasks observer) resolves", async () => {
    const client = makeClient();

    let resolveRefetch: (r: Response) => void = () => {};
    globalThis.fetch = mock((url: string) => {
      if (String(url).includes("/push")) {
        return Promise.resolve(jsonResponse({ status: "synced" }));
      }
      // GET /me/tasks — held open so the observable "refetch in flight"
      // window covers the mutation's own pending state.
      return new Promise<Response>((resolve) => {
        resolveRefetch = resolve;
      });
    }) as unknown as typeof fetch;

    // An active useTasks observer is required for invalidateQueries to
    // trigger a real refetch rather than just marking the cache stale.
    const tasksHook = renderHook(() => useTasks(), {
      wrapper: wrapper(client),
    });
    resolveRefetch(jsonResponse({ items: [] }));
    await waitFor(() => expect(tasksHook.result.current.isSuccess).toBe(true));

    const { result } = renderHook(() => useTaskPush(), {
      wrapper: wrapper(client),
    });

    result.current.mutate({ taskId: "task-1", adapterId: "attio" });

    // The push response has already resolved, but the mutation must remain
    // pending while the onSuccess-returned invalidation refetch is in flight.
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(result.current.isSuccess).toBe(false);

    resolveRefetch(jsonResponse({ items: [] }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
