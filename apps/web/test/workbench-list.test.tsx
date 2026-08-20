// The sidebar list's "Working" group (`WorkbenchList` in
// `../src/shell/workbench-list.tsx`): a quiet list of the signed-in
// user's running tasks, hidden entirely when there's nothing running,
// dropping a task on the list's next refresh once it completes, and
// opening the Inbox on click — a task is spawn-and-return, its result
// lands there, not on a dedicated detail page (see `TaskComposerDialog`'s
// own header comment).
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { WorkbenchList } from "../src/shell/workbench-list";
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(data: {
  readonly tasks?: readonly unknown[];
  readonly needsYou?: readonly unknown[];
}): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: [], nextCursor: null }));
    if (path.includes("/approvals/needs-you"))
      return Promise.resolve(json({ items: data.needsYou ?? [] }));
    if (path.includes("/tasks"))
      return Promise.resolve(json({ items: data.tasks ?? [] }));
    if (path.includes("/agent-definitions/visible"))
      return Promise.resolve(json({ definitions: [] }));
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
}

function needsYouItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "apr_1",
    agentName: "Myra",
    benchName: "Corbits Bench",
    headline: "Merge the checkout fix",
    arguments: {},
    status: "pending",
    createdAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function runningTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "tsk_1",
    // Planner-created agents (myra-task-*) are excluded from
    // listTenantInvitableDefinitions (CL-6051) — using that id here
    // proves the row's name comes from the task's own agentName, not a
    // definitions lookup this band no longer even fetches.
    definitionId: "wfd_myra_task_1",
    workbenchId: "ch_1",
    agentName: "Incident triage",
    prompt: "Summarize the thread",
    modelPreference: null,
    status: "running",
    runId: "run_1",
    runIds: ["run_1"],
    stepCount: 1,
    resultMailId: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

async function mount(onNavigate: (to: string) => void = () => undefined) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <BenchProvider>
          <WorkbenchList path="/w" onNavigate={onNavigate} />
        </BenchProvider>
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

describe("WorkbenchList — Working group", () => {
  test("shows a running task with its agent's display name", async () => {
    stubFetch({ tasks: [runningTask()] });
    const el = await mount();
    expect(el.textContent).toContain("Working");
    expect(el.textContent).toContain("Incident triage");
  });

  test("hides the group entirely when there's nothing running", async () => {
    stubFetch({ tasks: [] });
    const el = await mount();
    expect(el.textContent).not.toContain("Working");
  });

  test("a completed task leaves the list", async () => {
    stubFetch({
      tasks: [
        runningTask({
          id: "tsk_done",
          status: "done",
          completedAt: "2026-08-14T00:05:00.000Z",
        }),
      ],
    });
    const el = await mount();
    expect(el.textContent).not.toContain("Working");
  });

  test("clicking a working task opens its workbench", async () => {
    stubFetch({ tasks: [runningTask()] });
    let navigatedTo: string | null = null;
    const el = await mount((to) => {
      navigatedTo = to;
    });
    const button = el.querySelector("button");
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigatedTo as string | null).toBe("/w/ch_1");
  });

  test("clicking a working task with no workbench opens its run in Insights", async () => {
    stubFetch({ tasks: [runningTask({ workbenchId: null })] });
    let navigatedTo: string | null = null;
    const el = await mount((to) => {
      navigatedTo = to;
    });
    const button = el.querySelector("button");
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigatedTo as string | null).toBe("/insights/runs/run_1");
  });
});

describe("WorkbenchList — needs-you signal", () => {
  test("hides the signal when nothing is pending", async () => {
    stubFetch({ tasks: [], needsYou: [] });
    const el = await mount();
    expect(el.textContent).not.toContain("waiting on you");
  });

  test("shows a filled needs-you chip with the real pending count", async () => {
    stubFetch({
      tasks: [],
      needsYou: [needsYouItem(), needsYouItem({ id: "apr_2" })],
    });
    const el = await mount();
    expect(el.textContent).toContain("2 waiting on you");
    const chip = el.querySelector('.chip[data-tone="needs-you"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("Needs you");
  });
});
