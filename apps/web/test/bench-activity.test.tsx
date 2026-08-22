// `useBenchActivity` is the second column's one data source: it refetches
// on bench changes, not on route changes, and reports "empty" rather than
// fetching anything when there is no bench selected yet. Every listing it
// reads goes through the shared `tenantKeys` factories (see
// `../src/query-client.ts`), so this hook's two mounts (`WorkbenchesBand` and
// `LiveActivityBand`) share one cache rather than each firing its own
// fetch — proven end to end in `fetch-dedupe.test.tsx`.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WORKBENCHES_MUTATED_EVENT } from "@corbits/chat-ui";

import { useBenchActivity } from "../src/shell/bench-activity";
import type { BenchActivityQuery } from "../src/shell/bench-activity";
import { TestQueryProvider } from "./test-query-provider";

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
    readonly workbenches?: readonly unknown[];
    readonly chats?: readonly unknown[];
    readonly runs?: readonly unknown[];
    readonly agents?: readonly unknown[];
  } = {},
): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push(path);
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: data.runs ?? [], nextCursor: null }));
    if (path.includes("/agent-definitions/visible"))
      return Promise.resolve(json({ definitions: data.agents ?? [] }));
    if (path.includes("kind=chat"))
      return Promise.resolve(json({ items: data.chats ?? [] }));
    return Promise.resolve(json({ items: data.workbenches ?? [] }));
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
    root.render(
      <TestQueryProvider>
        <Probe tenantId={tenantId} />
      </TestQueryProvider>,
    );
  });
  return { latest: () => latest, root, container };
}

async function settle() {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
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

  test("fetches workbenches, chats, and running routines for the selected bench", async () => {
    const calls: string[] = [];
    stubTenantFetch(calls);
    const { latest, root, container } = await mountHook("tnt_1");
    await settle();
    expect(latest()).toEqual({
      kind: "ready",
      workbenches: [],
      chats: [],
      agents: [],
      routines: [],
    });
    // Per-kind workbench fetches — the shared query key each listing surface
    // subscribes to (see `tenantKeys.workbenches`).
    expect(calls.some((path) => path.includes("kind=workbench"))).toBe(true);
    expect(calls.some((path) => path.includes("kind=chat"))).toBe(true);
    expect(calls.some((path) => path.includes("/top-level-runs"))).toBe(true);
    expect(
      calls.some((path) => path.includes("/agent-definitions/visible")),
    ).toBe(true);
    root.unmount();
    container.remove();
  });

  test("splits workbenches by kind and shows only genuine top-level runs", async () => {
    const calls: string[] = [];
    stubTenantFetch(calls, {
      workbenches: [
        {
          id: "run_host1",
          title: "General",
          kind: "workbench",
          pinned: true,
          participants: [
            { address: "run_invited1@tnt1.example", handle: "echo" },
          ],
        },
      ],
      chats: [
        {
          id: "run_chat1",
          title: "echo",
          kind: "chat",
          pinned: false,
          participants: [],
        },
      ],
      // The workbench host and the invited agent never appear here: the
      // hub's `/top-level-runs` route excludes every folded run
      // server-side (see `@corbits/folded-runs`'s `scope-routes.ts`),
      // so this mock reflects exactly what that route returns — only
      // the genuine deployment.
      runs: [
        {
          id: "run_deployment1",
          definitionId: "def_researcher",
          workbenchId: "ch_1",
          definitionName: "researcher",
          tenantId: "tnt_1",
          address: "run_deployment1@tnt1.example",
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const { latest, root, container } = await mountHook("tnt_1");
    await settle();
    const state = latest();
    if (state.kind !== "ready") throw new Error(`not ready: ${state.kind}`);
    expect(state.workbenches.map((c) => c.id)).toEqual(["run_host1"]);
    expect(state.chats.map((c) => c.id)).toEqual(["run_chat1"]);
    expect(state.routines.map((r) => r.id)).toEqual(["run_deployment1"]);
    root.unmount();
    container.remove();
  });

  test("surfaces every visible agent definition, own and inherited", async () => {
    const calls: string[] = [];
    stubTenantFetch(calls, {
      agents: [
        {
          id: "wfd_outreach",
          name: "Outreach",
          tenantId: "tnt_ancestor",
          tenantName: "Acme",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const { latest, root, container } = await mountHook("tnt_1");
    await settle();
    const state = latest();
    if (state.kind !== "ready") throw new Error(`not ready: ${state.kind}`);
    expect(state.agents).toEqual([
      {
        id: "wfd_outreach",
        name: "Outreach",
        tenantId: "tnt_ancestor",
        tenantName: "Acme",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    root.unmount();
    container.remove();
  });

  // CL-6387: a workbench minted anywhere (picker, agent launch, land-hop)
  // must show up in the sidebar the moment `createWorkbench` resolves — no
  // waiting for the next unrelated refetch. `WORKBENCHES_MUTATED_EVENT` is
  // the one signal every create path shares; this proves the listener
  // actually invalidates the cached listing and the new row appears,
  // rather than just proving the event fires (see
  // `packages/chat-ui/test/workbenches-mutated-event.test.ts` for that).
  test("a WORKBENCHES_MUTATED_EVENT for this tenant refetches and surfaces the new workbench immediately", async () => {
    const calls: string[] = [];
    let workbenches: readonly unknown[] = [];
    stubTenantFetch(calls, {
      get workbenches() {
        return workbenches;
      },
    });
    const { latest, root, container } = await mountHook("tnt_1");
    await settle();
    expect(
      (latest() as { workbenches?: readonly unknown[] }).workbenches,
    ).toEqual([]);

    // The row a fresh `createWorkbench` call would have returned — present
    // in the backing store now, as if the mint had just landed.
    workbenches = [
      {
        id: "run_fresh1",
        title: "New Workbench",
        kind: "workbench",
        pinned: true,
        participants: [],
      },
    ];

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKBENCHES_MUTATED_EVENT, {
          detail: { tenantId: "tnt_1" },
        }),
      );
    });
    await settle();

    const state = latest();
    if (state.kind !== "ready") throw new Error(`not ready: ${state.kind}`);
    expect(state.workbenches.map((w) => w.id)).toEqual(["run_fresh1"]);

    root.unmount();
    container.remove();
  });

  test("a WORKBENCHES_MUTATED_EVENT for a different tenant does not trigger a refetch here", async () => {
    const calls: string[] = [];
    stubTenantFetch(calls);
    const { latest, root, container } = await mountHook("tnt_1");
    await settle();
    const callsBeforeEvent = calls.length;

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKBENCHES_MUTATED_EVENT, {
          detail: { tenantId: "tnt_other" },
        }),
      );
    });
    await settle();

    expect(calls.length).toBe(callsBeforeEvent);
    const state = latest();
    if (state.kind !== "ready") throw new Error(`not ready: ${state.kind}`);
    expect(state.workbenches).toEqual([]);

    root.unmount();
    container.remove();
  });
});
