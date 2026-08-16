// The inbox stage mounts the shared top bar: counts as the subtitle and the
// bulk actions (Mark all read / Clear done) as right-aligned bar actions —
// no page-local header.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { resetPendingDialogRequests } from "../src/command-palette-actions";
import { NavigationProvider } from "../src/navigation";
import { InboxPage } from "../src/pages/inbox-page";
import { suggestRoutineNameFromPrompt } from "../src/routines-api";
import {
  CanvasAvailabilityProvider,
  type RoutinePanelSubject,
} from "../src/shell/canvas-availability";
import { TestQueryProvider } from "./test-query-provider";

/** Stands in for `ShellChromeProvider`'s position above `InboxPage` — just
 * enough of the canvas host context for `useOpenRoutineInCanvas` to resolve
 * to a real, capturing callback instead of the no-op default. */
function CanvasCapture({
  onOpenRoutine,
  children,
}: {
  readonly onOpenRoutine: (subject: RoutinePanelSubject) => void;
  readonly children: ReactNode;
}) {
  return (
    <CanvasAvailabilityProvider
      allowed={false}
      open={false}
      profile={null}
      artifact={null}
      routine={null}
      focus={false}
      openProfile={noop}
      openArtifact={noop}
      openRoutine={onOpenRoutine}
      toggleFocus={noop}
      close={noop}
    >
      {children}
    </CanvasAvailabilityProvider>
  );
}

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

const TASK_PROMPT = "Summarize last night's incident into a postmortem draft.";

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

const failedTaskResultItem = {
  ...taskResultItem,
  id: "mail_2",
  subject: "“Incident Summarizer” failed your task",
  refs: [{ kind: "task", id: "task_2" }],
};

function taskRecord(overrides: {
  readonly id: string;
  readonly status: "done" | "failed" | "running";
}) {
  return {
    item: {
      id: overrides.id,
      definitionId: "wfd_summarizer",
      agentName: "Incident Summarizer",
      prompt: TASK_PROMPT,
      modelPreference: null,
      status: overrides.status,
      runId: "run_1",
      runIds: ["run_1"],
      stepCount: 1,
      resultMailId: overrides.status === "done" ? "mail_1" : null,
      createdAt: "2026-08-15T09:00:00.000Z",
      completedAt:
        overrides.status === "running" ? null : "2026-08-15T10:00:00.000Z",
    },
  };
}

const plannerTaskResponse = {
  task: {
    id: "task_2",
    definitionId: "wfd_created",
    agentName: "Researcher",
    prompt: "Refined outcome",
    modelPreference: null,
    status: "queued",
    runId: "run_2",
    runIds: ["run_2"],
    stepCount: 1,
    resultMailId: null,
    plannerRunId: "run_planner_1",
    createdAt: "2026-08-15T10:00:00.000Z",
    completedAt: null,
  },
  plannerRunId: "run_planner_1",
};

let plannerCalls: string[] = [];
let tasksCalls: string[] = [];

// The Routines picker's catalog is automatable-only, filtered client-side
// via `purposeDefinitions` (isAutomatableWorkflowName + not a channel
// host) — a task's own agent is conversational, so it is NEVER a member
// of this list. This mirrors production exactly: the recurring-task
// bridge workflow (`RECURRING_TASK_ASSET_NAME`, seeded once per tenant
// per `packages/hub-client/src/seed.ts`) is the only entry, and its id
// (`wfd_recurring_task`) is deliberately disjoint from the task's own
// agent id (`wfd_summarizer`) below — the exact shape a real bench has,
// and the shape whose disjointness broke the very first version of this
// feature (it prefilled the dialog with the task's own agent id, which
// never resolved in this list).
const WORKFLOW_DEFINITIONS_RESPONSE = {
  data: [
    {
      id: "wfd_recurring_task",
      name: "recurring-task",
      status: "deployed",
    },
  ],
  nextCursor: null,
};

/** `items` is what the inbox list route answers with — each test picks
 * which task-result item(s) are in view. `definitions` defaults to the
 * production-shaped, disjoint-from-the-task-agent catalog above; a test
 * proving the "no recurring-task deployed yet" case overrides it empty. */
function makeRouteFetch(
  items: readonly unknown[],
  definitions: unknown = WORKFLOW_DEFINITIONS_RESPONSE,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
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
    if (url.includes("/tasks/task_1")) {
      return Promise.resolve(
        jsonResponse(taskRecord({ id: "task_1", status: "done" })),
      );
    }
    if (url.includes("/tasks/task_2")) {
      return Promise.resolve(
        jsonResponse(taskRecord({ id: "task_2", status: "failed" })),
      );
    }
    if (url.includes("/inbox/mail_1")) {
      return Promise.resolve(
        jsonResponse({ ...taskResultItem, body: "All clear." }),
      );
    }
    if (url.includes("/inbox/mail_2")) {
      return Promise.resolve(
        jsonResponse({ ...failedTaskResultItem, body: "Ran into an error." }),
      );
    }
    if (url.includes("/workflows/definitions")) {
      return Promise.resolve(jsonResponse(definitions));
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
    if (url.includes("/inbox")) {
      return Promise.resolve(jsonResponse({ items }));
    }
    if (url.includes("/tasks")) {
      tasksCalls.push(String(init?.body ?? ""));
      return Promise.reject(
        new Error("createTask should not be called for the Myra default"),
      );
    }
    return Promise.reject(new Error(`unrouted fetch in inbox test: ${url}`));
  };
}

const routeFetch = makeRouteFetch([taskResultItem]);

/** Same routing as `makeRouteFetch`, but `/planner` answers with a bare
 * 500 and no error envelope — `dispatchPlanner`'s fallback message embeds
 * the raw request path (`request to /api/tenants/.../planner failed with
 * 500`), the exact shape the inbox task-start error must never render
 * verbatim. */
function makeFailingPlannerRouteFetch(): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  const base = makeRouteFetch([taskResultItem]);
  return (input, init) => {
    const url = String(input);
    if (url.includes("/planner")) {
      return Promise.resolve(
        new Response("", {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return base(input, init);
  };
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
    resetPendingDialogRequests();
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

  async function waitForText(text: string) {
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.textContent?.includes(text)) return;
    }
    throw new Error(`timed out waiting for "${text}"`);
  }

  async function settle(ticks = 10) {
    for (let i = 0; i < ticks; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function buttonWithText(text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent === text,
    );
  }

  test("shows 'Make this a routine' on a successful task result", async () => {
    globalThis.fetch = makeRouteFetch([taskResultItem]) as typeof fetch;
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
    await waitForText("All clear.");
    await waitForText("Make this a routine");

    expect(buttonWithText("Make this a routine")).not.toBeUndefined();
  });

  test("hides 'Make this a routine' on a failed task result", async () => {
    globalThis.fetch = makeRouteFetch([failedTaskResultItem]) as typeof fetch;
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
    await waitForText("Ran into an error.");
    // Give the task fetch a chance to settle before asserting its absence.
    await settle();

    expect(buttonWithText("Make this a routine")).toBeUndefined();
  });

  test("accepting 'Make this a routine' opens the routine panel pre-filled from the task, and creates nothing on its own", async () => {
    const navigated: string[] = [];
    const opened: RoutinePanelSubject[] = [];
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <CanvasCapture onOpenRoutine={(subject) => opened.push(subject)}>
                <InboxPage
                  path="/inbox"
                  navigate={(to) => {
                    navigated.push(to);
                  }}
                />
              </CanvasCapture>
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    await waitForText("All clear.");
    await waitForText("Make this a routine");

    const button = buttonWithText("Make this a routine");
    if (button === undefined) throw new Error("affordance not rendered");
    await act(async () => {
      button.click();
    });

    // Never auto-creates, never navigates away — opens the panel in
    // place, pre-filled and awaiting the person's own save.
    expect(navigated).toEqual([]);
    expect(opened).toEqual([
      {
        routineId: null,
        initialName: suggestRoutineNameFromPrompt(TASK_PROMPT),
        initialInstruction: TASK_PROMPT,
      },
    ]);
  });

  test("hides 'Make this a routine' when no recurring-task bridge workflow is deployed for this tenant yet", async () => {
    // Even on a successful task result, the affordance must not offer a
    // dead end: without a resolvable recurring-task definitionId there
    // is nothing honest to prefill.
    globalThis.fetch = makeRouteFetch([taskResultItem], {
      data: [],
      nextCursor: null,
    }) as typeof fetch;

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
    await waitForText("All clear.");
    await settle();

    expect(buttonWithText("Make this a routine")).toBeUndefined();
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

  test("a failed task start shows plain copy, never the raw request path — for an Error and for a non-Error alike", async () => {
    globalThis.fetch = makeFailingPlannerRouteFetch() as typeof fetch;

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

    let alert: Element | null = null;
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      alert = document.body.querySelector('[role="alert"]');
      if (alert !== null) break;
    }
    if (alert === null) throw new Error("task error alert not rendered");
    expect(alert.textContent).toBe(
      "Something went wrong starting that task. Try again.",
    );
    expect(alert.textContent).not.toMatch(/\/api\//);
    expect(alert.textContent).not.toContain("tnt_1");
  });
});
