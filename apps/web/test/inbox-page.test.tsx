// The inbox stage mounts the shared top bar: counts as the subtitle and the
// bulk actions (Mark all read / Clear done) as right-aligned bar actions —
// no page-local header.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { InboxPage } from "../src/pages/inbox-page";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const realFetch = globalThis.fetch;

const membership = {
  principalId: "prn_1",
  tenantId: "tnt_1",
  tenantName: "Test Bench",
  tenantSlug: "test-bench",
  kind: "user",
  status: "active",
  roles: [],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const taskResultItem = {
  id: "mail_1",
  group: "delivery",
  from: "task-result@notify.test",
  fromDisplay: "Tasks",
  subject: "“Incident Summarizer” finished your task",
  date: "2026-08-15T10:00:00.000Z",
  read: false,
  status: "open",
  refs: [
    { kind: "task", id: "task_1" },
    { kind: "run", id: "run_1" },
    { kind: "artifact", id: "art_1", label: "Postmortem draft" },
  ],
};

const plannerTaskResponse = {
  task: {
    id: "task_2",
    definitionId: "wfd_created",
    agentName: "Researcher",
    prompt: "Refined outcome",
    modelPreference: null,
    status: "queued",
    runId: "run_2",
    resultMailId: null,
    plannerRunId: "run_planner_1",
    createdAt: "2026-08-15T10:00:00.000Z",
    completedAt: null,
  },
  plannerRunId: "run_planner_1",
};

let plannerCalls: string[] = [];
let tasksCalls: string[] = [];

function routeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = String(input);
  if (url.includes("/api/me/principals")) {
    return Promise.resolve(
      jsonResponse({ data: [membership], nextCursor: null }),
    );
  }
  if (url.includes("/inbox/counts")) {
    return Promise.resolve(
      jsonResponse({ action: 2, mention: 1, delivery: 0, open: 5 }),
    );
  }
  if (url.includes("/inbox/mail_1")) {
    return Promise.resolve(
      jsonResponse({ ...taskResultItem, body: "All clear." }),
    );
  }
  if (url.includes("/inbox")) {
    return Promise.resolve(jsonResponse({ items: [taskResultItem] }));
  }
  if (url.includes("/chat/invitable-definitions")) {
    return Promise.resolve(jsonResponse({ items: [] }));
  }
  if (url.includes("/catalog/models")) {
    return Promise.resolve(jsonResponse({ data: [] }));
  }
  if (url.includes("/planner")) {
    plannerCalls.push(String(init?.body ?? ""));
    return Promise.resolve(jsonResponse(plannerTaskResponse));
  }
  if (url.includes("/tasks")) {
    tasksCalls.push(String(init?.body ?? ""));
    return Promise.reject(
      new Error("createTask should not be called for the Myra default"),
    );
  }
  return Promise.reject(new Error(`unrouted fetch in inbox test: ${url}`));
}

describe("inbox top bar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.fetch = routeFetch as typeof fetch;
    plannerCalls = [];
    tasksCalls = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    window.localStorage.clear();
  });

  test("shows counts and the bulk actions in the shared bar", async () => {
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <InboxPage path="/inbox" navigate={noop} />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("need action")) break;
    }

    const bar = container.querySelector('[data-testid="stage-top-bar"]');
    if (bar === null) throw new Error("stage top bar not rendered");
    expect(bar.textContent).toContain("Inbox");
    expect(bar.textContent).toContain("2 need action · 5 open");
    expect(bar.textContent).toContain("Mark all read");
    expect(bar.textContent).toContain("Clear done");
  });

  test("a task-result item's artifact refs render as chips deep-linking into the Library", async () => {
    const navigated: string[] = [];
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <InboxPage
                path="/inbox"
                navigate={(to) => {
                  navigated.push(to);
                }}
              />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("inbox-artifact-chips")) break;
    }

    const chips = container.querySelector(
      '[data-testid="inbox-artifact-chips"]',
    );
    if (chips === null) throw new Error("artifact chips not rendered");
    const chip = [...chips.querySelectorAll("button")].find(
      (button) => button.textContent === "Postmortem draft",
    );
    if (chip === undefined) throw new Error("artifact chip not rendered");

    await act(async () => {
      chip.click();
    });
    expect(navigated).toEqual(["/library/a/art_1"]);
  });

  test("submitting with the Myra default dispatches to the planner, not /tasks, and never saves it as the MRU agent", async () => {
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <InboxPage path="/inbox" navigate={noop} />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("need action")) break;
    }

    // `Dialog` portals its content onto `document.body`, not `container`
    // — the same pattern `create-agent-dialog.test.tsx` queries against.
    const newTaskButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "New task",
    );
    if (newTaskButton === undefined)
      throw new Error("New task button not rendered");
    await act(async () => {
      newTaskButton.click();
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (document.body.textContent?.includes("Let Myra choose") === true)
        break;
    }

    const textarea = document.body.querySelector("textarea");
    if (textarea === null) throw new Error("prompt textarea not rendered");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Summarize the last incident");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submitButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Start task",
    );
    if (submitButton === undefined)
      throw new Error("Start task button not rendered");
    await act(async () => {
      submitButton.click();
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (plannerCalls.length > 0) break;
    }

    expect(plannerCalls).toEqual([
      JSON.stringify({ outcome: "Summarize the last incident" }),
    ]);
    expect(tasksCalls).toEqual([]);
    expect(
      window.localStorage.getItem("workbench.tasks.mru-agent:tnt_1"),
    ).toBeNull();
  });
});
