/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { MailboxMessage } from "@workbench/shared";
import { unreadCount as realUnreadCount } from "../../hooks/use-mailbox";

let bellData: MailboxMessage[] | undefined;

mock.module("../../hooks/use-mailbox", () => ({
  useMailbox: () => ({ data: bellData }),
  unreadCount: realUnreadCount,
  MAILBOX_POLL_MS: 30_000,
}));
mock.module("../../hooks/use-mailbox-live", () => ({
  useMailboxLive: () => {},
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

afterEach(() => {
  cleanup();
  bellData = undefined;
});
bellData = undefined;

describe("NotificationsBell", () => {
  it("shows the unread count on the bell", () => {
    bellData = [
      makeMessage({ id: "1", read: false }),
      makeMessage({ id: "2", read: false }),
      makeMessage({ id: "3", read: true }),
    ];
    renderBell();
    screen.getByRole("button", { name: /2 unread/i });
  });

  it("shows no unread indicator when everything is read", () => {
    bellData = [makeMessage({ id: "1", read: true })];
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
});
