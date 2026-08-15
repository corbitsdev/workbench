// The Spaces band's "Working" group (`ChannelsBand` in
// `../src/shell/panel-contributions.tsx`): a quiet list of the signed-in
// user's running tasks, hidden entirely when there's nothing running,
// clearing a task the instant it completes, and opening the Inbox on
// click — a task is spawn-and-return, its result lands there, not on a
// dedicated detail page (see `TaskComposerDialog`'s own header comment).
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { ChannelsBand } from "../src/shell/panel-contributions";
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
  readonly definitions?: readonly unknown[];
}): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/workflows/deployments"))
      return Promise.resolve(json([]));
    if (path.includes("/tasks"))
      return Promise.resolve(json({ items: data.tasks ?? [] }));
    if (path.includes("/chat/invitable-definitions"))
      return Promise.resolve(json({ items: data.definitions ?? [] }));
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
}

function runningTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "tsk_1",
    definitionId: "def_researcher",
    prompt: "Summarize the thread",
    modelPreference: null,
    status: "running",
    runId: "run_1",
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
          <ChannelsBand path="/channels" onNavigate={onNavigate} />
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

describe("ChannelsBand — Working group", () => {
  test("shows a running task with its agent's display name", async () => {
    stubFetch({
      tasks: [runningTask()],
      definitions: [{ id: "def_researcher", name: "Researcher" }],
    });
    const el = await mount();
    expect(el.textContent).toContain("Working");
    expect(el.textContent).toContain("Researcher");
  });

  test("hides the group entirely when there's nothing running", async () => {
    stubFetch({ tasks: [], definitions: [] });
    const el = await mount();
    expect(el.textContent).not.toContain("Working");
  });

  test("a completed task leaves the band", async () => {
    stubFetch({
      tasks: [
        runningTask({
          id: "tsk_done",
          status: "done",
          completedAt: "2026-08-14T00:05:00.000Z",
        }),
      ],
      definitions: [{ id: "def_researcher", name: "Researcher" }],
    });
    const el = await mount();
    expect(el.textContent).not.toContain("Working");
  });

  test("clicking a working task navigates to the Inbox", async () => {
    stubFetch({
      tasks: [runningTask()],
      definitions: [{ id: "def_researcher", name: "Researcher" }],
    });
    let navigatedTo: string | null = null;
    const el = await mount((to) => {
      navigatedTo = to;
    });
    const button = el.querySelector("button");
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigatedTo as string | null).toBe("/inbox");
  });
});
