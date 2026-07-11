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
import type { MailboxMessage, MailboxMessageDetail } from "@workbench/shared";

type MailboxState = {
  data: MailboxMessage[] | undefined;
  isLoading: boolean;
  isError: boolean;
};

type DetailState = {
  data: MailboxMessageDetail | undefined;
  isLoading: boolean;
  isError: boolean;
};

let mailbox: MailboxState;
let detail: DetailState;
let refetchCalls = 0;
const markReadIds: string[] = [];
const detailQueryIds: (string | null)[] = [];

mock.module("../hooks/use-mailbox", () => ({
  useMailbox: () => ({
    data: mailbox.data,
    isLoading: mailbox.isLoading,
    isError: mailbox.isError,
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
    };
  },
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
  detail = { data: undefined, isLoading: false, isError: false };
  refetchCalls = 0;
  markReadIds.length = 0;
  detailQueryIds.length = 0;
});

// Reset before the first test too.
mailbox = { data: undefined, isLoading: false, isError: false };
detail = { data: undefined, isLoading: false, isError: false };

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
    fireEvent.click(screen.getByText("Deck ready"));
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
});
