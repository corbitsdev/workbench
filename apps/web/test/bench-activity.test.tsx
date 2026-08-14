// `useBenchActivity` is the second column's one data source: it refetches
// on bench changes, not on route changes, and reports "empty" rather than
// fetching anything when there is no bench selected yet.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useBenchActivity } from "../src/shell/bench-activity";
import type { BenchActivityQuery } from "../src/shell/bench-activity";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function stubTenantFetch(calls: string[]): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push(path);
    if (path.includes("/workflows/deployments"))
      return Promise.resolve(json([]));
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
}

async function mountHook(tenantId: string | null): Promise<{
  readonly latest: () => BenchActivityQuery;
  readonly root: Root;
  readonly container: HTMLDivElement;
}> {
  let latest: BenchActivityQuery = { kind: "loading" };
  function Probe({ tenantId }: { readonly tenantId: string | null }) {
    latest = useBenchActivity(tenantId);
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe tenantId={tenantId} />);
  });
  return { latest: () => latest, root, container };
}

describe("useBenchActivity", () => {
  test("reports empty with no bench selected, fetching nothing", async () => {
    const calls: string[] = [];
    stubTenantFetch(calls);
    const { latest, root, container } = await mountHook(null);
    expect(latest()).toEqual({ kind: "empty" });
    expect(calls).toEqual([]);
    root.unmount();
    container.remove();
  });

  test("fetches channels, chats, and running routines for the selected bench", async () => {
    const calls: string[] = [];
    stubTenantFetch(calls);
    const { latest, root, container } = await mountHook("tnt_1");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest()).toEqual({
      kind: "ready",
      channels: [],
      chats: [],
      routines: [],
    });
    expect(calls.some((path) => path.includes("kind=channel"))).toBe(true);
    expect(calls.some((path) => path.includes("kind=chat"))).toBe(true);
    expect(calls.some((path) => path.includes("/workflows/deployments"))).toBe(
      true,
    );
    root.unmount();
    container.remove();
  });
});
