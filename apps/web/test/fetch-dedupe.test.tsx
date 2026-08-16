// CL-6045: the shell used to fire the same listing 4-5x per navigation
// because independent components each fetched independently instead of
// sharing a cache. Every mount of `useBenchActivity` (the sidebar's
// `WorkbenchList`, and any second subscriber) shares the same TanStack
// Query keys (`tenantKeys.channels`, `.tasks`, `.topLevelRuns` — see
// `../src/query-client.ts`) under one `QueryClient`, so two mounts fetch
// each listing exactly once.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { requestChannelRename } from "../src/channel-rename-events";
import { WorkbenchList } from "../src/shell/workbench-list";
import {
  createTestQueryClient,
  TestQueryProvider,
} from "./test-query-provider";

const realFetch = globalThis.fetch;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const membership = {
  data: [
    {
      principalId: "prn_1",
      tenantId: "tnt_1",
      tenantName: "Corbits Bench",
      tenantSlug: "corbits-bench",
      kind: "user",
      status: "active",
      roles: [],
    },
  ],
  nextCursor: null,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(calls: string[]): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push(path);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: [], nextCursor: null }));
    if (path.includes("/tasks")) return Promise.resolve(json({ items: [] }));
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
}

async function settle() {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function countsByMatch(
  calls: readonly string[],
  predicate: (path: string) => boolean,
): number {
  return calls.filter(predicate).length;
}

describe("shell listing dedupe (CL-6045)", () => {
  test("two WorkbenchList mounts together fetch each listing exactly once", async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const queryClient = createTestQueryClient();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider client={queryClient}>
          <BenchProvider>
            <WorkbenchList path="/c" onNavigate={() => undefined} />
            <WorkbenchList path="/c" onNavigate={() => undefined} />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
    await settle();

    // Before the fix, each of these fired once per mounted band (2x here,
    // and up to 5x across the shell's real surfaces) — now exactly once
    // per (tenant, kind) no matter how many bands subscribe.
    expect(countsByMatch(calls, (p) => p.includes("kind=channel"))).toBe(1);
    expect(countsByMatch(calls, (p) => p.includes("kind=chat"))).toBe(1);
    expect(countsByMatch(calls, (p) => p.includes("/top-level-runs"))).toBe(1);
    expect(countsByMatch(calls, (p) => p.includes("/tasks"))).toBe(1);
  });

  test("a rename invalidates the shared listing query, triggering exactly one refetch", async () => {
    const calls: string[] = [];
    const channel = {
      id: "ch_1",
      title: "General",
      kind: "channel",
      pinned: false,
      participants: [],
    };
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path.includes("/api/me/principals"))
        return Promise.resolve(json(membership));
      if (path.includes("/top-level-runs"))
        return Promise.resolve(json({ data: [], nextCursor: null }));
      if (path.includes("/tasks")) return Promise.resolve(json({ items: [] }));
      if (init?.method === "PATCH") {
        return Promise.resolve(
          json({
            ...channel,
            title: "Renamed",
            settings: {},
            contextWindow: { value: 20, source: "inherit" },
          }),
        );
      }
      if (path.includes("kind=channel"))
        return Promise.resolve(json({ items: [channel] }));
      return Promise.resolve(json({ items: [] }));
    }) as typeof fetch;
    const queryClient = createTestQueryClient();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider client={queryClient}>
          <BenchProvider>
            <WorkbenchList path="/c" onNavigate={() => undefined} />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
    await settle();

    expect(countsByMatch(calls, (p) => p.includes("kind=channel"))).toBe(1);

    act(() => requestChannelRename("ch_1"));
    await settle();
    const input = container.querySelector(
      'input[aria-label="Rename"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter === undefined) {
      throw new Error("HTMLInputElement.prototype.value has no native setter");
    }
    act(() => {
      setter.call(input, "Renamed");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await settle();

    // One refetch, triggered by the rename's invalidateQueries — not zero
    // (freshness must actually fire) and not more than one (no duplicate
    // invalidation sites).
    expect(countsByMatch(calls, (p) => p.includes("kind=channel"))).toBe(2);
  });
});
