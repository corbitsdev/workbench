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

function stubTenantFetch(
  calls: string[],
  data: {
    readonly channels?: readonly unknown[];
    readonly runs?: readonly unknown[];
  } = {},
): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push(path);
    if (path.includes("/workflows/deployments"))
      return Promise.resolve(json(data.runs ?? []));
    return Promise.resolve(json({ items: data.channels ?? [] }));
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
    // One all-kinds channels fetch (no kind= param), split client-side.
    expect(
      calls.some(
        (path) => path.includes("/chat/channels") && !path.includes("kind="),
      ),
    ).toBe(true);
    expect(calls.some((path) => path.includes("/workflows/deployments"))).toBe(
      true,
    );
    root.unmount();
    container.remove();
  });

  test("splits channels by kind and keeps folded/chat runs out of routines", async () => {
    const calls: string[] = [];
    stubTenantFetch(calls, {
      channels: [
        {
          id: "run_host1",
          title: "General",
          kind: "channel",
          pinned: true,
          participants: [
            { address: "run_invited1@tnt1.example", handle: "echo" },
          ],
        },
        {
          id: "run_chat1",
          title: "echo",
          kind: "chat",
          pinned: false,
          participants: [],
        },
      ],
      runs: [
        {
          id: "run_deployment1",
          tenantId: "tnt_1",
          definitionAssetId: "researcher/workflow.json",
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "run_host1",
          tenantId: "tnt_1",
          definitionAssetId: "run-abc/workflow.json",
          status: "running",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "run_invited1",
          tenantId: "tnt_1",
          definitionAssetId: "researcher/workflow.json",
          status: "running",
          createdAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    });
    const { latest, root, container } = await mountHook("tnt_1");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const state = latest();
    if (state.kind !== "ready") throw new Error(`not ready: ${state.kind}`);
    expect(state.channels.map((c) => c.id)).toEqual(["run_host1"]);
    expect(state.chats.map((c) => c.id)).toEqual(["run_chat1"]);
    // The channel host and the invited agent self-anchor like real
    // deployments, so the deployments listing carries them — the
    // "Running" band must not.
    expect(state.routines.map((r) => r.id)).toEqual(["run_deployment1"]);
    root.unmount();
    container.remove();
  });
});
