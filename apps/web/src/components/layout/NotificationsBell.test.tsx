/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { MailboxMessage, Task } from "@workbench/shared";
let bellData: MailboxMessage[] | undefined;
let bellUnreadCount: number | undefined;
let bellTaskData: Task[] | undefined;

mock.module("../../hooks/use-mailbox", () => ({
  useMailbox: () => ({ data: bellData }),
  useMailboxUnreadCount: () => ({ data: bellUnreadCount }),
  MAILBOX_POLL_MS: 30_000,
}));
mock.module("../../hooks/use-mailbox-live", () => ({
  useMailboxLive: () => {},
}));
mock.module("../../hooks/use-tasks", () => ({
  useTasks: () => ({ data: bellTaskData }),
}));

const { NotificationsBell } = require("./NotificationsBell");

function makeMessage(over: Partial<MailboxMessage>): MailboxMessage {
  return {
    id: "msg-x",
    from: "Someone",
    to: ["you@example.com"],
    date: "2026-07-11T09:00:00.000Z",
    messageId: "mid-x",
    read: false,
    ...over,
  };
}

function renderBell() {
  const router = createMemoryRouter(
    [
      { path: "/", element: React.createElement(NotificationsBell) },
      { path: "/inbox", element: React.createElement("div", null, "Inbox") },
      {
        path: "/inbox/:messageId",
        element: React.createElement("div", null, "Detail"),
      },
    ],
    { initialEntries: ["/"] },
  );
  render(React.createElement(RouterProvider, { router }));
  return router;
}

function makeTask(over: Partial<Task>): Task {
  return {
    id: "task-x",
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
    createdByPrincipalId: "principal-1",
    title: "Follow up with Acme",
    status: "open",
    source: "user",
    links: [],
    externalRefs: [],
    createdAt: "2026-07-11T09:00:00.000Z",
    updatedAt: "2026-07-11T09:00:00.000Z",
    ...over,
  };
}

afterEach(() => {
  cleanup();
  bellData = undefined;
  bellUnreadCount = undefined;
  bellTaskData = undefined;
});
bellData = undefined;
bellUnreadCount = undefined;
bellTaskData = undefined;

describe("NotificationsBell", () => {
  it("shows the unread count on the bell", () => {
    bellData = [
      makeMessage({ id: "1", read: false }),
      makeMessage({ id: "2", read: false }),
      makeMessage({ id: "3", read: true }),
    ];
    bellUnreadCount = 2;
    renderBell();
    screen.getByRole("button", { name: /2 unread/i });
  });

  it("shows no unread indicator when everything is read", () => {
    bellData = [makeMessage({ id: "1", read: true })];
    bellUnreadCount = 0;
    renderBell();
    expect(screen.queryByRole("button", { name: /unread/i })).toBeNull();
    // The bell itself is still present, just without an unread label.
    screen.getByRole("button", { name: /notifications/i });
  });

  it("opens a dropdown listing the most recent messages", () => {
    bellData = [
      makeMessage({ id: "1", from: "Myra", subject: "Morning brief" }),
      makeMessage({ id: "2", from: "Oat", subject: "Deck ready" }),
    ];
    renderBell();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    screen.getByText("Morning brief");
    screen.getByText("Deck ready");
  });

  it("caps the dropdown at the eight most recent messages", () => {
    bellData = Array.from({ length: 12 }, (_, i) =>
      makeMessage({ id: `m-${i}`, subject: `Subject ${i}` }),
    );
    renderBell();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    screen.getByText("Subject 0");
    screen.getByText("Subject 7");
    expect(screen.queryByText("Subject 8")).toBeNull();
  });

  it("caps ref chips at two and folds the rest into a +N more link", () => {
    bellData = [
      makeMessage({
        id: "msg-refs",
        subject: "A workflow needs you",
        refs: [
          { kind: "workflow_run", ref: "wfr-1", label: "Open run" },
          { kind: "task", ref: "t-1", label: "Open task" },
          { kind: "artifact", ref: "a-1", label: "Open deck" },
          { kind: "linear", ref: "https://linear.app/x/I-1", label: "I-1" },
        ],
      }),
    ];
    renderBell();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    screen.getByText("Open run");
    screen.getByText("Open task");
    expect(screen.queryByText("Open deck")).toBeNull();
    screen.getByText("+2 more");
  });

  it("never renders a raw enum kind for a ref without a label", () => {
    bellData = [
      makeMessage({
        id: "msg-nolabel",
        subject: "Heads up",
        refs: [{ kind: "workflow_run", ref: "wfr-9" }],
      }),
    ];
    renderBell();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    // Shared defaultRefLabel, not the raw "workflow_run" enum.
    screen.getByText("Open run");
    expect(screen.queryByText("workflow_run")).toBeNull();
  });

  it("deep-links a message to its inbox detail", () => {
    bellData = [
      makeMessage({ id: "msg-2", from: "Oat", subject: "Deck ready" }),
    ];
    const router = renderBell();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    fireEvent.click(screen.getByText("Deck ready"));
    expect(router.state.location.pathname).toBe("/inbox/msg-2");
  });

  it("routes View all to the inbox page", () => {
    bellData = [makeMessage({ id: "1", subject: "One" })];
    const router = renderBell();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    fireEvent.click(screen.getByRole("link", { name: /view all/i }));
    expect(router.state.location.pathname).toBe("/inbox");
  });

  it("shows a friendly empty state when there are no messages", () => {
    bellData = [];
    renderBell();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    screen.getByText("You're all caught up");
  });

  it("lists open tasks alongside mail and deep-links them to their inbox selection", () => {
    bellData = [];
    bellTaskData = [
      makeTask({ id: "t-1", title: "Draft renewal note", status: "open" }),
      makeTask({ id: "t-2", title: "Done task", status: "done" }),
    ];
    const router = renderBell();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    screen.getByText("Draft renewal note");
    expect(screen.queryByText("Done task")).toBeNull();
    fireEvent.click(screen.getByText("Draft renewal note"));
    expect(router.state.location.pathname).toBe("/inbox");
    expect(router.state.location.search).toBe("?task=t-1");
  });

  it("carries the task id on the notification entry's href", () => {
    bellData = [];
    bellTaskData = [
      makeTask({ id: "t-42", title: "Follow up with Acme", status: "open" }),
    ];
    renderBell();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    const link = screen.getByRole("link", { name: /follow up with acme/i });
    expect(link.getAttribute("href")).toBe("/inbox?task=t-42");
  });

  it("does not count open tasks toward the unread badge", () => {
    bellData = [];
    bellTaskData = [makeTask({ id: "t-1", status: "open" })];
    renderBell();
    expect(screen.queryByRole("button", { name: /unread/i })).toBeNull();
  });
});
