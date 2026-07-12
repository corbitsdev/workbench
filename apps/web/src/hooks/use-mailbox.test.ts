/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import type { MailboxMessage } from "@workbench/shared";

class TestApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let apiResponses: unknown[];
let apiCalls: { method: string; path: string }[];
mock.module("../lib/api", () => ({
  ApiError: TestApiError,
  api: (method: string, path: string) => {
    apiCalls.push({ method, path });
    const next = apiResponses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
}));

const {
  unreadCount,
  MAILBOX_QUERY_KEY,
  MAILBOX_POLL_MS,
  MAILBOX_PAGE_LIMIT,
  useMailbox,
  useMailboxMessage,
  useMarkMailboxRead,
  isMessageNotFound,
} = require("./use-mailbox");

function msg(over: Partial<MailboxMessage>): MailboxMessage {
  return {
    id: "m",
    from: "a@b.com",
    to: ["you@b.com"],
    date: "2026-07-11T09:00:00.000Z",
    messageId: "mid",
    read: false,
    ...over,
  };
}

function wrapper(client?: QueryClient) {
  const queryClient =
    client ??
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

afterEach(() => {
  apiResponses = [];
  apiCalls = [];
});
apiResponses = [];
apiCalls = [];

describe("unreadCount", () => {
  it("counts only unread messages", () => {
    expect(
      unreadCount([
        msg({ id: "1", read: false }),
        msg({ id: "2", read: true }),
        msg({ id: "3", read: false }),
      ]),
    ).toBe(2);
  });

  it("returns 0 for an undefined mailbox", () => {
    expect(unreadCount(undefined)).toBe(0);
  });
});

describe("mailbox query constants", () => {
  it("shares one query key so the page and bell read the same cache", () => {
    expect(MAILBOX_QUERY_KEY).toEqual(["mailbox"]);
  });

  it("polls the ambient bell surface on a bounded cadence", () => {
    expect(MAILBOX_POLL_MS).toBe(30_000);
  });

  it("matches the hub's default page size", () => {
    expect(MAILBOX_PAGE_LIMIT).toBe(50);
  });
});

describe("useMailbox", () => {
  it("fetches the first page with an explicit limit and no cursor", async () => {
    apiResponses = [{ messages: [msg({ id: "1", subject: "Hi" })] }];
    const { result } = renderHook(() => useMailbox(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((m: MailboxMessage) => m.id)).toEqual([
      "1",
    ]);
    expect(apiCalls).toEqual([
      { method: "GET", path: `/me/inbox?limit=${MAILBOX_PAGE_LIMIT}` },
    ]);
  });

  it("flattens multiple loaded pages into one array and reports hasNextPage", async () => {
    apiResponses = [
      {
        messages: [msg({ id: "1" }), msg({ id: "2" })],
        nextCursor: "cursor-a",
      },
      { messages: [msg({ id: "3" })] },
    ];
    const { result } = renderHook(() => useMailbox(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((m: MailboxMessage) => m.id)).toEqual([
      "1",
      "2",
    ]);
    expect(result.current.hasNextPage).toBe(true);

    result.current.fetchNextPage();
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));

    expect(result.current.data?.map((m: MailboxMessage) => m.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(apiCalls).toEqual([
      { method: "GET", path: `/me/inbox?limit=${MAILBOX_PAGE_LIMIT}` },
      {
        method: "GET",
        path: `/me/inbox?limit=${MAILBOX_PAGE_LIMIT}&cursor=cursor-a`,
      },
    ]);
  });

  it("reports no next page when the server omits nextCursor", async () => {
    apiResponses = [{ messages: [msg({ id: "1" })] }];
    const { result } = renderHook(() => useMailbox(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });

  it("surfaces an error when the response fails the boundary parse", async () => {
    apiResponses = [{ messages: [{ id: 5 }] }];
    const { result } = renderHook(() => useMailbox(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("does not fetch while disabled", () => {
    apiResponses = [{ messages: [] }];
    renderHook(() => useMailbox({ enabled: false }), { wrapper: wrapper() });
    expect(apiCalls).toEqual([]);
  });
});

describe("useMailboxMessage", () => {
  it("fetches the message detail and returns the parsed body", async () => {
    apiResponses = [{ ...msg({ id: "m-1" }), body: "Full body text" }];
    const { result } = renderHook(() => useMailboxMessage("m-1"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.body).toBe("Full body text");
    expect(apiCalls).toEqual([{ method: "GET", path: "/me/inbox/m-1" }]);
  });

  it("surfaces an error when the detail fails the boundary parse", async () => {
    apiResponses = [{ ...msg({ id: "m-1" }), body: 42 }];
    const { result } = renderHook(() => useMailboxMessage("m-1"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("does not fetch while no message is selected", () => {
    apiResponses = [{ ...msg({ id: "m-1" }), body: "x" }];
    renderHook(() => useMailboxMessage(null), { wrapper: wrapper() });
    expect(apiCalls).toEqual([]);
  });

  it("fetches by id regardless of which mailbox pages are loaded", async () => {
    apiResponses = [{ ...msg({ id: "m-old" }), body: "Archived note" }];
    const { result } = renderHook(() => useMailboxMessage("m-old"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe("m-old");
  });

  it("surfaces a 404 so the caller can tell a genuinely missing message apart from any other failure", async () => {
    apiResponses = [new TestApiError("not found", 404)];
    const { result } = renderHook(() => useMailboxMessage("m-gone"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isMessageNotFound(result.current.error)).toBe(true);
  });

  it("does not treat a non-404 failure as not-found", async () => {
    apiResponses = [new TestApiError("server error", 500)];
    const { result } = renderHook(() => useMailboxMessage("m-broken"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isMessageNotFound(result.current.error)).toBe(false);
  });
});

describe("useMarkMailboxRead across pages", () => {
  it("optimistically marks a message read on whichever loaded page holds it", async () => {
    apiResponses = [
      { messages: [msg({ id: "1" }), msg({ id: "2" })], nextCursor: "c1" },
      { messages: [msg({ id: "3" })] },
    ];
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const mailboxHook = renderHook(() => useMailbox(), {
      wrapper: wrapper(client),
    });
    await waitFor(() =>
      expect(mailboxHook.result.current.isSuccess).toBe(true),
    );
    mailboxHook.result.current.fetchNextPage();
    await waitFor(() =>
      expect(
        mailboxHook.result.current.data?.map((m: MailboxMessage) => m.id),
      ).toEqual(["1", "2", "3"]),
    );

    apiResponses.push({ id: "3", read: true });
    const markHook = renderHook(() => useMarkMailboxRead(), {
      wrapper: wrapper(client),
    });
    markHook.result.current.mutate("3");

    await waitFor(() => {
      const message = mailboxHook.result.current.data?.find(
        (m: MailboxMessage) => m.id === "3",
      );
      expect(message?.read).toBe(true);
    });

    // Every other message stays exactly as loaded — a mark-read on page two
    // never touches page one's rows.
    expect(
      mailboxHook.result.current.data?.find((m: MailboxMessage) => m.id === "1")
        ?.read,
    ).toBe(false);
  });

  it("rolls back the optimistic mark on a failed request", async () => {
    apiResponses = [{ messages: [msg({ id: "1", read: false })] }];
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const mailboxHook = renderHook(() => useMailbox(), {
      wrapper: wrapper(client),
    });
    await waitFor(() =>
      expect(mailboxHook.result.current.isSuccess).toBe(true),
    );

    apiResponses.push(new Error("boom"));
    const markHook = renderHook(() => useMarkMailboxRead(), {
      wrapper: wrapper(client),
    });
    markHook.result.current.mutate("1");

    await waitFor(() => expect(markHook.result.current.isError).toBe(true));
    expect(
      mailboxHook.result.current.data?.find((m: MailboxMessage) => m.id === "1")
        ?.read,
    ).toBe(false);
  });
});
