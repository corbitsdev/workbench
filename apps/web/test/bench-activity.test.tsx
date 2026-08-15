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
    readonly tasks?: readonly unknown[];
  } = {},
): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push(path);
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: data.runs ?? [], nextCursor: null }));
    if (path.includes("/tasks"))
      return Promise.resolve(json({ items: data.tasks ?? [] }));
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
      workingTasks: [],
    });
    // One all-kinds channels fetch (no kind= param), split client-side.
    expect(
      calls.some(
        (path) => path.includes("/chat/channels") && !path.includes("kind="),
      ),
    ).toBe(true);
    expect(calls.some((path) => path.includes("/top-level-runs"))).toBe(true);
    expect(calls.some((path) => path.includes("/tasks"))).toBe(true);
    root.unmount();
    container.remove();
  });

  test("splits channels by kind and shows only genuine top-level runs", async () => {
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
      // The channel host and the invited agent never appear here: the
      // hub's `/top-level-runs` route excludes every folded run
      // server-side (see `@corbits/folded-runs`'s `scope-routes.ts`),
      // so this mock reflects exactly what that route returns — only
      // the genuine deployment.
      runs: [
        {
          id: "run_deployment1",
          definitionId: "def_researcher",
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
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const state = latest();
    if (state.kind !== "ready") throw new Error(`not ready: ${state.kind}`);
    expect(state.channels.map((c) => c.id)).toEqual(["run_host1"]);
    expect(state.chats.map((c) => c.id)).toEqual(["run_chat1"]);
    expect(state.routines.map((r) => r.id)).toEqual(["run_deployment1"]);
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
          agentName: "Incident triage",
          prompt: "Summarize the thread",
          modelPreference: null,
          status: "running",
          runId: "run_tsk1",
          resultMailId: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          completedAt: null,
        },
        {
          id: "tsk_done",
          definitionId: "def_researcher",
          agentName: "Researcher",
          prompt: "Draft the summary",
          modelPreference: null,
          status: "done",
          runId: "run_tsk2",
          resultMailId: "mail_1",
          createdAt: "2026-08-13T00:00:00.000Z",
          completedAt: "2026-08-13T00:05:00.000Z",
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
