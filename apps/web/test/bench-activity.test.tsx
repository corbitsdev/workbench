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
    readonly tasks?: readonly unknown[];
    readonly agents?: readonly unknown[];
  } = {},
): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push(path);
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: data.runs ?? [], nextCursor: null }));
    if (path.includes("/tasks"))
      return Promise.resolve(json({ items: data.tasks ?? [] }));
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
      workingTasks: [],
    });
    // Per-kind workbench fetches — the shared query key each listing surface
    // subscribes to (see `tenantKeys.workbenches`).
    expect(calls.some((path) => path.includes("kind=workbench"))).toBe(true);
    expect(calls.some((path) => path.includes("kind=chat"))).toBe(true);
    expect(calls.some((path) => path.includes("/top-level-runs"))).toBe(true);
    expect(calls.some((path) => path.includes("/tasks"))).toBe(true);
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

  test("keeps a task's own agentName and drops terminal tasks", async () => {
    const calls: string[] = [];
    stubTenantFetch(calls, {
      tasks: [
        {
          id: "tsk_running",
          definitionId: "wfd_myra_task_1",
          workbenchId: "ch_1",
          agentName: "Incident triage",
          prompt: "Summarize the thread",
          modelPreference: null,
          status: "running",
          runId: "run_tsk1",
          runIds: ["run_tsk1"],
          stepCount: 1,
          resultMailId: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          completedAt: null,
        },
        {
          id: "tsk_done",
          definitionId: "def_researcher",
          workbenchId: "ch_1",
          agentName: "Researcher",
          prompt: "Draft the summary",
          modelPreference: null,
          status: "done",
          runId: "run_tsk2",
          runIds: ["run_tsk2"],
          stepCount: 1,
          resultMailId: "mail_1",
          createdAt: "2026-08-13T00:00:00.000Z",
          completedAt: "2026-08-13T00:05:00.000Z",
        },
      ],
    });
    const { latest, root, container } = await mountHook("tnt_1");
    await settle();
    const state = latest();
    if (state.kind !== "ready") throw new Error(`not ready: ${state.kind}`);
    // A planner-created agent (wfd_myra_task_1) never appears in
    // listTenantInvitableDefinitions (CL-6051) — the name still shows
    // because it travels on the task record itself, not a lookup.
    expect(state.workingTasks).toEqual([
      expect.objectContaining({
        id: "tsk_running",
        agentName: "Incident triage",
      }),
    ]);
    root.unmount();
    container.remove();
  });
});
