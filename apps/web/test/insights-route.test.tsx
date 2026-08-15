// CL-6062: Insights' run feed reads from the tenant-scoped top-level-runs
// endpoint (packages/folded-runs/src/scope-routes.ts), not the dead
// `/me/workflows/runs` (every addressed run self-anchors at creation, so
// that feed's `anchorRunId IS NULL` filter never matched anything). These
// tests exercise the real fetch wiring `InsightsRoute` owns — the unit
// tests in `../src/insights-stats.test.ts` cover the pure filtering logic.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { InsightsRoute } from "../src/pages/insights-page";
import { TestQueryProvider } from "./test-query-provider";

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

// Recent-runs/KPI windowing is relative to "now" (InsightsRoute creates its
// own window with no fixed clock), so this fixture's createdAt tracks real
// time instead of a fixed date to stay inside the last-7-days window.
const deployment = {
  id: "run_deployed",
  definitionId: "wfd_1",
  definitionName: "Morning brief",
  tenantId: "tnt_1",
  address: "run_deployed@acme.localhost",
  status: "running",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type RecordedCall = { readonly path: string };

function stubFetch(runsBody: { data: readonly unknown[] }): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push({ path });
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/api/channel-tenancies/kinds"))
      return Promise.resolve(json({ channelTenantIds: [] }));
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: runsBody.data, nextCursor: null }));
    if (path.includes("/insights/usage"))
      return Promise.resolve(
        json({
          turns: 0,
          tokens: {
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            thinking: 0,
            total: 0,
          },
          costUsd: null,
          byModel: [],
        }),
      );
    if (path.includes("/insights/activity"))
      return Promise.resolve(json({ days: [] }));
    if (path.includes("/insights/tools"))
      return Promise.resolve(json({ tools: [] }));
    if (path.includes("/routines"))
      return Promise.resolve(json({ data: [], nextCursor: null }));
    if (path.includes("/me/workflows/runs"))
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: "dead endpoint" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
    return Promise.resolve(json({ data: [], nextCursor: null }));
  }) as typeof fetch;
  return calls;
}

async function mount(path = "/insights") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <NavigationProvider navigate={() => undefined}>
          <BenchProvider>
            <InsightsRoute path={path} />
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

describe("InsightsRoute run feed", () => {
  test("a real deployment run reaches the KPI/recent-runs surface", async () => {
    const calls = stubFetch({ data: [deployment] });
    const el = await mount();
    expect(el.textContent).toContain("Morning brief");
    expect(calls.some((c) => c.path.includes("/top-level-runs"))).toBe(true);
    expect(calls.some((c) => c.path.includes("/me/workflows/runs"))).toBe(
      false,
    );
  });

  test("an empty tenant shows an honest zero, not an error", async () => {
    stubFetch({ data: [] });
    const el = await mount();
    expect(el.textContent).not.toContain("Couldn't load insights");
    expect(el.textContent).not.toContain("Morning brief");
  });

  test("the runs history view never falls back to the dead /me/workflows/runs feed", async () => {
    const calls = stubFetch({ data: [deployment] });
    const el = await mount("/insights/runs");
    expect(el.textContent).toContain("Morning brief");
    expect(calls.some((c) => c.path.includes("/top-level-runs"))).toBe(true);
    expect(calls.some((c) => c.path.includes("/me/workflows/runs"))).toBe(
      false,
    );
  });
});
