// CL-7198: the coalescing refresh timer was a single ref, neither scoped
// to nor cleared on the active workbench id. A pending timer scheduled
// for one workbench made a different workbench's `refreshFeed()` call
// early-return, and the timer then invalidated the first workbench's own
// (now-inactive) query key instead. Stubs `globalThis.fetch` — never
// `mock.module` for `../src/api`, per test/chat-workspace.test.tsx's note.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  chatFeedQueryKeyPrefix,
  useWorkbenchFeed,
} from "../src/use-workbench-feed";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/threads$/.test(path)) return json({ rootThreadId: "", items: [] });
    if (/\/messages/.test(path)) return json({ items: [] });
    if (/\/pins$/.test(path)) return json({ items: [] });
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(tenantId: string, initialWorkbenchId: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient();
  const invalidateCalls: (readonly unknown[])[] = [];
  const originalInvalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((
    filters?: Parameters<typeof queryClient.invalidateQueries>[0],
  ) => {
    if (filters?.queryKey !== undefined) {
      invalidateCalls.push(filters.queryKey);
    }
    return originalInvalidate(filters);
  }) as typeof queryClient.invalidateQueries;

  const root = createRoot(container);
  let setWorkbenchId: (id: string) => void = () => undefined;
  let refreshFeed: () => void = () => undefined;

  function Host() {
    const [workbenchId, updateWorkbenchId] = useState(initialWorkbenchId);
    setWorkbenchId = updateWorkbenchId;
    const feed = useWorkbenchFeed({ tenantId, activeWorkbenchId: workbenchId });
    refreshFeed = feed.refreshFeed;
    return null;
  }

  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Host),
      ),
    );
  });

  return {
    switchWorkbench: (id: string) =>
      act(() => {
        setWorkbenchId(id);
      }),
    refreshFeed: () =>
      act(() => {
        refreshFeed();
      }),
    settle: (ms: number) => act(() => sleep(ms)),
    invalidateCalls: () => invalidateCalls,
    unmount: () => act(() => root.unmount()),
  };
}

describe("useWorkbenchFeed — refresh timer scoping across a workbench switch (CL-7198)", () => {
  test("a refresh scheduled for bench A never fires, and bench B's own refresh fires once switching happens before the coalesce window closes", async () => {
    stubFetch();
    const harness = mount("ten_1", "ch_a");
    await harness.settle(0);

    harness.refreshFeed();
    harness.switchWorkbench("ch_b");
    harness.refreshFeed();

    await harness.settle(400);

    expect(harness.invalidateCalls()).toEqual([
      chatFeedQueryKeyPrefix("ten_1", "ch_b"),
    ]);
    harness.unmount();
  });

  test("a second refresh call for the same bench inside the coalesce window is a no-op, not a second timer", async () => {
    stubFetch();
    const harness = mount("ten_1", "ch_a");
    await harness.settle(0);

    harness.refreshFeed();
    harness.refreshFeed();
    harness.refreshFeed();

    await harness.settle(400);

    expect(harness.invalidateCalls()).toEqual([
      chatFeedQueryKeyPrefix("ten_1", "ch_a"),
    ]);
    harness.unmount();
  });
});
