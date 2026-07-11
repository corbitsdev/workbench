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
import { createMemoryRouter, RouterProvider } from "react-router";
import type { MailboxMessage } from "@workbench/shared";

type MailboxState = {
  data: MailboxMessage[] | undefined;
  isLoading: boolean;
  isError: boolean;
};

let mailbox: MailboxState;
let refetchCalls = 0;
const markReadIds: string[] = [];

mock.module("../hooks/use-mailbox", () => ({
  useMailbox: () => ({
    data: mailbox.data,
    isLoading: mailbox.isLoading,
    isError: mailbox.isError,
    refetch: () => {
      refetchCalls += 1;
    },
  }),
  useMarkMailboxRead: () => ({
    mutate: (id: string) => {
      markReadIds.push(id);
    },
  }),
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

function renderInbox(initialPath = "/inbox") {
  const router = createMemoryRouter(
    [
      { path: "/inbox", element: React.createElement(InboxPage) },
      { path: "/inbox/:messageId", element: React.createElement(InboxPage) },
    ],
    { initialEntries: [initialPath] },
  );
  render(React.createElement(RouterProvider, { router }));
  return router;
}

afterEach(() => {
  cleanup();
  mailbox = { data: undefined, isLoading: false, isError: false };
  refetchCalls = 0;
  markReadIds.length = 0;
});

// Reset before the first test too.
mailbox = { data: undefined, isLoading: false, isError: false };

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
    screen.getByText("Your inbox is clear");
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
    screen.getByText("Morning brief");
    screen.getByText("Deck ready");
    screen.getByText("Myra");
    screen.getByText("Oat");
  });

  it("opens a message on row click and shows its body in the reading pane", () => {
    mailbox = {
      data: [
        makeMessage({ id: "msg-1", subject: "Morning brief", snippet: "One" }),
        makeMessage({
          id: "msg-2",
          subject: "Deck ready",
          snippet: "The deck is ready to review",
        }),
      ],
      isLoading: false,
      isError: false,
    };
    const router = renderInbox();
    fireEvent.click(screen.getByText("Deck ready"));
    expect(router.state.location.pathname).toBe("/inbox/msg-2");
    // The reading pane renders the subject as a heading (rows use a span), so
    // this proves the detail opened — not merely that the row exists.
    screen.getByRole("heading", { name: "Deck ready" });
    const article = screen.getByRole("article");
    within(article).getByText("The deck is ready to review");
  });

  it("selects the deep-linked message without a click", () => {
    mailbox = {
      data: [
        makeMessage({
          id: "msg-1",
          subject: "Morning brief",
          snippet: "Your brief for today",
        }),
        makeMessage({ id: "msg-2", subject: "Deck ready", snippet: "Two" }),
      ],
      isLoading: false,
      isError: false,
    };
    renderInbox("/inbox/msg-1");
    screen.getByRole("heading", { name: "Morning brief" });
    const article = screen.getByRole("article");
    within(article).getByText("Your brief for today");
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
});
