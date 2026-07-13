/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import type {
  MailboxMessage,
  MailboxMessageDetail,
  NowRun,
  Task,
} from "@workbench/shared";

class TestApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

type MailboxState = {
  data: MailboxMessage[] | undefined;
  isLoading: boolean;
  isError: boolean;
};

type DetailState = {
  data: MailboxMessageDetail | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
};

type ListState<T> = {
  data: T[] | undefined;
  isLoading: boolean;
  isError: boolean;
};

type TaskLookupState = {
  data: Task | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
};

type PageState = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
};

let mailbox: MailboxState;
let mailboxPaging: PageState;
let detail: DetailState;
let tasksState: ListState<Task>;
let tasksPaging: PageState;
let runsState: ListState<NowRun>;
let taskLookup: TaskLookupState;
let refetchCalls = 0;
let fetchNextMailboxCalls = 0;
let fetchNextTasksCalls = 0;
const markReadIds: string[] = [];
const detailQueryIds: (string | null)[] = [];
const taskLookupIds: (string | null)[] = [];

mock.module("../hooks/use-tasks", () => ({
  TASKS_QUERY_KEY: ["tasks"],
  useTasks: () => ({
    data: tasksState.data,
    isLoading: tasksState.isLoading,
    isError: tasksState.isError,
    hasNextPage: tasksPaging.hasNextPage,
    isFetchingNextPage: tasksPaging.isFetchingNextPage,
    fetchNextPage: () => {
      fetchNextTasksCalls += 1;
    },
  }),
  useTask: (id: string | null) => {
    taskLookupIds.push(id);
    return {
      data: taskLookup.data,
      isLoading: taskLookup.isLoading,
      isError: taskLookup.isError,
      error: taskLookup.error,
    };
  },
  isTaskNotFound: (error: unknown) =>
    error instanceof TestApiError && error.status === 404,
}));

mock.module("../hooks/use-workflow", () => ({
  useWorkflowRuns: () => runsState,
}));

mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({ activeTenantId: null }),
}));

mock.module("../hooks/use-mailbox", () => ({
  MAILBOX_POLL_MS: 30_000,
  useMailbox: () => ({
    data: mailbox.data,
    isLoading: mailbox.isLoading,
    isError: mailbox.isError,
    hasNextPage: mailboxPaging.hasNextPage,
    isFetchingNextPage: mailboxPaging.isFetchingNextPage,
    fetchNextPage: () => {
      fetchNextMailboxCalls += 1;
    },
    refetch: () => {
      refetchCalls += 1;
    },
  }),
  useMailboxMessage: (id: string | null) => {
    detailQueryIds.push(id);
    return {
      data: detail.data,
      isLoading: detail.isLoading,
      isError: detail.isError,
      error: detail.error,
    };
  },
  useMarkMailboxRead: () => ({
    mutate: (id: string) => {
      markReadIds.push(id);
    },
  }),
  isMessageNotFound: (error: unknown) =>
    error instanceof TestApiError && error.status === 404,
}));

const { InboxPage } = require("./InboxPage");

function makeMessage(over: Partial<MailboxMessage>): MailboxMessage {
  return {
    id: "msg-x",
    from: "Someone <someone@example.com>",
    to: ["you@example.com"],
    date: "2026-07-11T09:00:00.000Z",
    messageId: "mid-x",
    read: false,
    ...over,
  };
}

function makeTask(over: Partial<Task>): Task {
  return {
    id: "task-x",
    tenantId: "ten-1",
    ownerPrincipalId: "prn-1",
    createdByPrincipalId: "prn-2",
    title: "Follow up",
    status: "open",
    source: "user",
    links: [],
    externalRefs: [],
    createdAt: "2026-07-11T08:00:00.000Z",
    updatedAt: "2026-07-11T08:00:00.000Z",
    ...over,
  };
}

function makeRun(over: Partial<NowRun>): NowRun {
  return {
    runId: "run-x",
    kind: "call-to-collateral",
    status: "awaiting",
    createdAt: "2026-07-11T07:00:00.000Z",
    ...over,
  };
}

function renderInbox(initialPath = "/inbox") {
  const router = createMemoryRouter(
    [
      { path: "/inbox", element: React.createElement(InboxPage) },
      { path: "/inbox/:messageId", element: React.createElement(InboxPage) },
      {
        path: "/workflows/:workflowId",
        element: React.createElement("div", null, "Workflow run surface"),
      },
    ],
    { initialEntries: [initialPath] },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(RouterProvider, { router }),
    ),
  );
  return router;
}

function resetStates() {
  mailbox = { data: undefined, isLoading: false, isError: false };
  mailboxPaging = { hasNextPage: false, isFetchingNextPage: false };
  detail = { data: undefined, isLoading: false, isError: false };
  tasksState = { data: [], isLoading: false, isError: false };
  tasksPaging = { hasNextPage: false, isFetchingNextPage: false };
  runsState = { data: [], isLoading: false, isError: false };
  taskLookup = { data: undefined, isLoading: false, isError: false };
}

afterEach(() => {
  cleanup();
  resetStates();
  refetchCalls = 0;
  fetchNextMailboxCalls = 0;
  fetchNextTasksCalls = 0;
  markReadIds.length = 0;
  detailQueryIds.length = 0;
  taskLookupIds.length = 0;
});

// Reset before the first test too.
resetStates();

describe("InboxPage", () => {
  it("shows a loading state while the mailbox query is pending", () => {
    mailbox = { data: undefined, isLoading: true, isError: false };
    renderInbox();
    screen.getByText("Loading messages…");
  });

  it("shows an error with a retry that refetches", () => {
    mailbox = { data: undefined, isLoading: false, isError: true };
    renderInbox();
    screen.getByText("Couldn't load your inbox.");
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refetchCalls).toBe(1);
  });

  it("shows a friendly empty state when the inbox has no messages", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    renderInbox();
    expect(screen.getAllByText("You're all caught up").length).toBeGreaterThan(
      0,
    );
  });

  it("explains what fills the inbox and links to the morning brief settings", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    renderInbox();
    screen.getByText(
      /morning brief.*workflow approvals.*task updates.*mail from your agents/i,
    );
    const settingsLink = screen.getByRole("link", {
      name: /set up your morning brief/i,
    }) as HTMLAnchorElement;
    expect(settingsLink.getAttribute("href")).toBe("/settings#morning-brief");
  });

  it("links the inbox header to the morning brief settings section", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    renderInbox();
    const settingsLink = screen.getByRole("link", {
      name: /inbox settings/i,
    }) as HTMLAnchorElement;
    expect(settingsLink.getAttribute("href")).toBe("/settings#morning-brief");
  });

  it("renders every message in the list, not just the first", () => {
    mailbox = {
      data: [
        makeMessage({ id: "msg-1", from: "Myra", subject: "Morning brief" }),
        makeMessage({ id: "msg-2", from: "Oat", subject: "Deck ready" }),
      ],
      isLoading: false,
      isError: false,
    };
    renderInbox();
    const rail = screen.getByRole("list", { name: "Messages" });
    within(rail).getByText("Morning brief");
    within(rail).getByText("Deck ready");
    within(rail).getByText("Myra");
    within(rail).getByText("Oat");
  });

  it("opens a message on row click and shows its full body in the reading pane", () => {
    mailbox = {
      data: [
        makeMessage({ id: "msg-1", subject: "Morning brief", snippet: "One" }),
        makeMessage({
          id: "msg-2",
          subject: "Deck ready",
          snippet: "The deck is ready…",
        }),
      ],
      isLoading: false,
      isError: false,
    };
    detail = {
      data: {
        ...makeMessage({ id: "msg-2", subject: "Deck ready" }),
        body: "The deck is ready to review, with the full walkthrough attached.",
      },
      isLoading: false,
      isError: false,
    };
    const router = renderInbox();
    const rail = screen.getByRole("list", { name: "Messages" });
    fireEvent.click(within(rail).getByText("Deck ready"));
    expect(router.state.location.pathname).toBe("/inbox/msg-2");
    // The reading pane renders the subject as a heading (rows use a span), so
    // this proves the detail opened — not merely that the row exists.
    screen.getByRole("heading", { name: "Deck ready" });
    const article = screen.getByRole("article");
    within(article).getByText(
      "The deck is ready to review, with the full walkthrough attached.",
    );
    expect(detailQueryIds.at(-1)).toBe("msg-2");
  });

  it("renders a Related action row from the message refs", () => {
    mailbox = {
      data: [
        makeMessage({
          id: "msg-2",
          subject: "A workflow needs you",
          refs: [
            { kind: "workflow_run", ref: "wfr-1", label: "Open run" },
            { kind: "linear", ref: "https://linear.app/x/ISSUE-1" },
          ],
        }),
      ],
      isLoading: false,
      isError: false,
    };
    detail = {
      data: {
        ...makeMessage({
          id: "msg-2",
          subject: "A workflow needs you",
          refs: [
            { kind: "workflow_run", ref: "wfr-1", label: "Open run" },
            { kind: "linear", ref: "https://linear.app/x/ISSUE-1" },
          ],
        }),
        body: "Respond here.",
      },
      isLoading: false,
      isError: false,
    };
    const rail =
      renderInbox() && screen.getByRole("list", { name: "Messages" });
    fireEvent.click(within(rail).getByText("A workflow needs you"));
    const related = screen.getByRole("navigation", { name: "Related" });
    const runLink = within(related).getByRole("link", { name: "Open run" });
    expect(runLink.getAttribute("href")).toBe("/workflows/wfr-1");
    const linearLink = within(related).getByRole("link", {
      name: /Open in Linear/,
    });
    expect(linearLink.getAttribute("href")).toBe(
      "https://linear.app/x/ISSUE-1",
    );
    expect(linearLink.getAttribute("target")).toBe("_blank");
    expect(linearLink.getAttribute("rel")).toBe("noreferrer");
    // The external chip announces its new-tab behavior to assistive tech.
    expect(linearLink.textContent).toContain("(opens in new tab)");
  });

  it("selects the deep-linked message without a click", () => {
    mailbox = {
      data: [
        makeMessage({
          id: "msg-1",
          subject: "Morning brief",
          snippet: "Your brief…",
        }),
        makeMessage({ id: "msg-2", subject: "Deck ready", snippet: "Two" }),
      ],
      isLoading: false,
      isError: false,
    };
    detail = {
      data: {
        ...makeMessage({ id: "msg-1", subject: "Morning brief" }),
        body: "Your full brief for today, beyond the snippet.",
      },
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox/msg-1");
    screen.getByRole("heading", { name: "Morning brief" });
    const article = screen.getByRole("article");
    within(article).getByText("Your full brief for today, beyond the snippet.");
  });

  it("shows a quiet loading state in the pane while the body is fetching", () => {
    mailbox = {
      data: [makeMessage({ id: "msg-1", subject: "Morning brief" })],
      isLoading: false,
      isError: false,
    };
    detail = { data: undefined, isLoading: true, isError: false };
    renderInbox("/inbox/msg-1");
    screen.getByRole("heading", { name: "Morning brief" });
    const article = screen.getByRole("article");
    within(article).getByText("Loading message…");
  });

  it("falls back to a friendly note when the body cannot be loaded", () => {
    mailbox = {
      data: [makeMessage({ id: "msg-1", subject: "Morning brief" })],
      isLoading: false,
      isError: false,
    };
    detail = { data: undefined, isLoading: false, isError: true };
    renderInbox("/inbox/msg-1");
    const article = screen.getByRole("article");
    within(article).getByText("Couldn't load this message.");
  });

  it("shows the empty-body note when the message has no readable content", () => {
    mailbox = {
      data: [makeMessage({ id: "msg-1", subject: "Morning brief" })],
      isLoading: false,
      isError: false,
    };
    detail = {
      data: { ...makeMessage({ id: "msg-1" }), body: "" },
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox/msg-1");
    const article = screen.getByRole("article");
    within(article).getByText("No content available for this message.");
  });

  it("marks an unread message read once it is selected", () => {
    mailbox = {
      data: [
        makeMessage({ id: "msg-1", subject: "Morning brief", read: false }),
      ],
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox/msg-1");
    expect(markReadIds).toEqual(["msg-1"]);
  });

  it("does not re-mark a message that is already read", () => {
    mailbox = {
      data: [makeMessage({ id: "msg-1", subject: "Read one", read: true })],
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox/msg-1");
    expect(markReadIds).toEqual([]);
  });

  it("renders the pane for a message beyond the loaded mailbox pages, from the detail fetch alone", () => {
    mailbox = {
      data: [makeMessage({ id: "msg-1", subject: "Morning brief" })],
      isLoading: false,
      isError: false,
    };
    detail = {
      data: {
        ...makeMessage({ id: "msg-old", subject: "Archived note" }),
        body: "This message is far past the first loaded page.",
      },
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox/msg-old");
    screen.getByRole("heading", { name: "Archived note" });
    const article = screen.getByRole("article");
    within(article).getByText(
      "This message is far past the first loaded page.",
    );
    expect(detailQueryIds.at(-1)).toBe("msg-old");
  });

  it("shows an unavailable state for a message id that genuinely does not exist", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    detail = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new TestApiError("not found", 404),
    };
    renderInbox("/inbox/msg-gone");
    const article = screen.getByRole("article");
    within(article).getByText("This message is unavailable.");
    expect(within(article).queryByRole("heading")).toBeNull();
  });
});

describe("InboxPage Now feed", () => {
  it("orders awaiting gates before unread mail before open tasks", () => {
    runsState = {
      data: [makeRun({ runId: "run-1", kind: "call-to-collateral" })],
      isLoading: false,
      isError: false,
    };
    mailbox = {
      data: [makeMessage({ id: "msg-1", subject: "Morning brief" })],
      isLoading: false,
      isError: false,
    };
    tasksState = {
      data: [makeTask({ id: "task-1", title: "Call Acme back" })],
      isLoading: false,
      isError: false,
    };
    renderInbox();
    const feed = screen.getByRole("list", { name: "Now" });
    const rows = within(feed).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    within(rows[0]!).getByText("call-to-collateral");
    within(rows[1]!).getByText("Morning brief");
    within(rows[2]!).getByText("Call Acme back");
  });

  it("deep-links a gate row to the run's respond surface", () => {
    runsState = {
      data: [makeRun({ runId: "run-1" })],
      isLoading: false,
      isError: false,
    };
    mailbox = { data: [], isLoading: false, isError: false };
    const router = renderInbox();
    const feed = screen.getByRole("list", { name: "Now" });
    fireEvent.click(within(feed).getByText("call-to-collateral"));
    expect(router.state.location.pathname).toBe("/workflows/run-1");
  });

  it("deep-links a mail row into the reading pane", () => {
    mailbox = {
      data: [makeMessage({ id: "msg-1", subject: "Morning brief" })],
      isLoading: false,
      isError: false,
    };
    const router = renderInbox();
    const feed = screen.getByRole("list", { name: "Now" });
    fireEvent.click(within(feed).getByText("Morning brief"));
    expect(router.state.location.pathname).toBe("/inbox/msg-1");
  });

  it("deep-links a task row through its workflow_run link", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    tasksState = {
      data: [
        makeTask({
          id: "task-1",
          title: "Approve the deck",
          links: [{ kind: "workflow_run", ref: "run-9" }],
        }),
      ],
      isLoading: false,
      isError: false,
    };
    const router = renderInbox();
    const feed = screen.getByRole("list", { name: "Now" });
    fireEvent.click(within(feed).getByText("Approve the deck"));
    expect(router.state.location.pathname).toBe("/workflows/run-9");
  });

  it("drops responded gates, read mail, and done tasks, showing the caught-up state", () => {
    runsState = {
      data: [makeRun({ runId: "run-1", status: "completed" })],
      isLoading: false,
      isError: false,
    };
    mailbox = {
      data: [makeMessage({ id: "msg-1", subject: "Old news", read: true })],
      isLoading: false,
      isError: false,
    };
    tasksState = {
      data: [makeTask({ id: "task-1", status: "done" })],
      isLoading: false,
      isError: false,
    };
    renderInbox();
    screen.getByText("You're all caught up");
    expect(screen.queryByRole("list", { name: "Now" })).toBeNull();
  });

  it("shows the triage handoff as the primary row with the raw item collapsed", () => {
    mailbox = {
      data: [
        makeMessage({ id: "msg-raw", subject: "Pricing question from Acme" }),
        makeMessage({
          id: "msg-handoff",
          subject: "Myra triaged: Pricing question from Acme",
          date: "2026-07-11T10:00:00.000Z",
          refs: [{ kind: "mail", ref: "msg-raw", label: "Open original" }],
        }),
      ],
      isLoading: false,
      isError: false,
    };
    renderInbox();
    const feed = screen.getByRole("list", { name: "Now" });
    const rows = within(feed).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    within(rows[0]!).getByText("Myra triaged: Pricing question from Acme");
    within(rows[0]!).getByText("1 earlier item handled by Myra");
  });

  it("does not claim caught-up while the sources are still loading", () => {
    mailbox = { data: undefined, isLoading: true, isError: false };
    tasksState = { data: undefined, isLoading: true, isError: false };
    runsState = { data: undefined, isLoading: true, isError: false };
    renderInbox();
    expect(screen.queryByText("You're all caught up")).toBeNull();
  });

  it("renders a linkless task row as non-interactive, not a self-link", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    tasksState = {
      data: [makeTask({ id: "task-2", title: "Draft the recap" })],
      isLoading: false,
      isError: false,
    };
    const router = renderInbox();
    const feed = screen.getByRole("list", { name: "Now" });
    const title = within(feed).getByText("Draft the recap");
    expect(title.closest("a")).toBeNull();
    fireEvent.click(title);
    expect(router.state.location.pathname).toBe("/inbox");
    expect(router.state.location.search).toBe("");
  });

  it("highlights the now-feed row matching ?task=<id>", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    tasksState = {
      data: [
        makeTask({ id: "task-1", title: "Not selected" }),
        makeTask({ id: "task-2", title: "Selected task" }),
      ],
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox?task=task-2");
    const selectedRow = screen
      .getByText("Selected task")
      .closest('[aria-current="true"]');
    expect(selectedRow).not.toBeNull();
    const otherRow = screen
      .getByText("Not selected")
      .closest("li")
      ?.querySelector('[aria-current="true"]');
    expect(otherRow ?? null).toBeNull();
  });

  it("shows a quiet notice when ?task=<id> matches no feed row", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    tasksState = {
      data: [makeTask({ id: "task-1", title: "Still here" })],
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox?task=task-missing");
    screen.getByText("That task is no longer in your feed.");
  });

  it("omits the missing-task notice when ?task=<id> matches a feed row", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    tasksState = {
      data: [makeTask({ id: "task-1", title: "Still here" })],
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox?task=task-1");
    expect(
      screen.queryByText("That task is no longer in your feed."),
    ).toBeNull();
  });

  it("tells an unloaded-but-still-open task apart from a genuinely missing one", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    tasksState = {
      data: [makeTask({ id: "task-1", title: "Still here" })],
      isLoading: false,
      isError: false,
    };
    taskLookup = {
      data: makeTask({ id: "task-far", title: "Further down", status: "open" }),
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox?task=task-far");
    screen.getByText(
      "That task is further down your feed — use Show older to bring it in.",
    );
    expect(taskLookupIds.at(-1)).toBe("task-far");
  });

  it("tells a closed unloaded task apart from a genuinely missing one", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    tasksState = {
      data: [makeTask({ id: "task-1", title: "Still here" })],
      isLoading: false,
      isError: false,
    };
    taskLookup = {
      data: makeTask({ id: "task-done", title: "Wrapped up", status: "done" }),
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox?task=task-done");
    screen.getByText("That task is no longer open.");
  });

  it("keeps the existing wording for a task that truly no longer exists", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    tasksState = {
      data: [makeTask({ id: "task-1", title: "Still here" })],
      isLoading: false,
      isError: false,
    };
    taskLookup = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new TestApiError("not found", 404),
    };
    renderInbox("/inbox?task=task-missing");
    screen.getByText("That task is no longer in your feed.");
  });
});

describe("InboxPage load-more control", () => {
  it("hides the control when neither source has another page", () => {
    mailbox = {
      data: [makeMessage({ id: "msg-1" })],
      isLoading: false,
      isError: false,
    };
    renderInbox();
    expect(screen.queryByRole("button", { name: /show older/i })).toBeNull();
  });

  it("shows the control when the mailbox has another page and fetches it on click", () => {
    mailbox = {
      data: [makeMessage({ id: "msg-1" })],
      isLoading: false,
      isError: false,
    };
    mailboxPaging = { hasNextPage: true, isFetchingNextPage: false };
    renderInbox();
    fireEvent.click(screen.getByRole("button", { name: /show older/i }));
    expect(fetchNextMailboxCalls).toBe(1);
    expect(fetchNextTasksCalls).toBe(0);
  });

  it("shows the control when tasks have another page and fetches it on click", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    tasksState = {
      data: [makeTask({ id: "task-1", title: "Follow up" })],
      isLoading: false,
      isError: false,
    };
    tasksPaging = { hasNextPage: true, isFetchingNextPage: false };
    renderInbox();
    fireEvent.click(screen.getByRole("button", { name: /show older/i }));
    expect(fetchNextTasksCalls).toBe(1);
    expect(fetchNextMailboxCalls).toBe(0);
  });

  it("shows a loading label while a next page is fetching", () => {
    mailbox = { data: [], isLoading: false, isError: false };
    mailboxPaging = { hasNextPage: true, isFetchingNextPage: true };
    renderInbox();
    screen.getByRole("button", { name: /loading/i });
  });

  it("hides the control behind the reading pane when a message is selected", () => {
    mailbox = {
      data: [makeMessage({ id: "msg-1", subject: "Morning brief" })],
      isLoading: false,
      isError: false,
    };
    mailboxPaging = { hasNextPage: true, isFetchingNextPage: false };
    renderInbox("/inbox/msg-1");
    expect(screen.queryByRole("button", { name: /show older/i })).toBeNull();
  });
});
