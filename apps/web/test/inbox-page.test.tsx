// The inbox stage mounts the shared top bar: counts as the subtitle and the
// bulk actions (Mark all read / Clear done) as right-aligned bar actions —
// no page-local header.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { resetPendingDialogRequests } from "../src/command-palette-actions";
import { NavigationProvider } from "../src/navigation";
import { InboxPage } from "../src/pages/inbox-page";
import { consumePendingRoutinePrefill } from "../src/routine-prefill";
import { suggestRoutineNameFromPrompt } from "../src/routines-api";
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
      prompt: TASK_PROMPT,
      modelPreference: null,
      status: overrides.status,
      runId: "run_1",
      resultMailId: overrides.status === "done" ? "mail_1" : null,
      createdAt: "2026-08-15T09:00:00.000Z",
      completedAt:
        overrides.status === "running" ? null : "2026-08-15T10:00:00.000Z",
    },
  };
}

/** `items` is what the inbox list route answers with — each test picks
 * which task-result item(s) are in view. */
function makeRouteFetch(
  items: readonly unknown[],
): (input: RequestInfo | URL) => Promise<Response> {
  return (input) => {
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
    if (url.includes("/inbox")) {
      return Promise.resolve(jsonResponse({ items }));
    }
    return Promise.reject(new Error(`unrouted fetch in inbox test: ${url}`));
  };
}

const routeFetch = makeRouteFetch([taskResultItem]);

describe("inbox top bar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.fetch = routeFetch as typeof fetch;
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

  test("accepting 'Make this a routine' opens the prefilled routine flow and creates nothing on its own", async () => {
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
    await waitForText("All clear.");
    await waitForText("Make this a routine");

    const button = buttonWithText("Make this a routine");
    if (button === undefined) throw new Error("affordance not rendered");
    await act(async () => {
      button.click();
    });

    // Never auto-creates — clicking only navigates to the routine-creation
    // flow, pre-filled and awaiting the person's cadence pick and confirm.
    expect(navigated).toEqual(["/routines"]);
    expect(consumePendingRoutinePrefill()).toEqual({
      definitionId: "wfd_summarizer",
      name: suggestRoutineNameFromPrompt(TASK_PROMPT),
      input: { prompt: TASK_PROMPT },
    });
  });
});
