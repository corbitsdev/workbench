/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import type { MailboxMessage } from "@workbench/shared";

let apiResponse: unknown;
let apiCalls: { method: string; path: string }[];
mock.module("../lib/api", () => ({
  api: (method: string, path: string) => {
    apiCalls.push({ method, path });
    return Promise.resolve(apiResponse);
  },
}));

const {
  unreadCount,
  MAILBOX_QUERY_KEY,
  MAILBOX_POLL_MS,
  useMailbox,
  useMailboxMessage,
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

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  apiResponse = undefined;
  apiCalls = [];
});
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
});

describe("useMailbox", () => {
  it("fetches /me/inbox and returns the parsed messages", async () => {
    apiResponse = { messages: [msg({ id: "1", subject: "Hi" })] };
    const { result } = renderHook(() => useMailbox(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((m: MailboxMessage) => m.id)).toEqual([
      "1",
    ]);
    expect(apiCalls).toEqual([{ method: "GET", path: "/me/inbox" }]);
  });

  it("surfaces an error when the response fails the boundary parse", async () => {
    apiResponse = { messages: [{ id: 5 }] };
    const { result } = renderHook(() => useMailbox(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("does not fetch while disabled", () => {
    apiResponse = { messages: [] };
    renderHook(() => useMailbox({ enabled: false }), { wrapper: wrapper() });
    expect(apiCalls).toEqual([]);
  });
});

describe("useMailboxMessage", () => {
  it("fetches the message detail and returns the parsed body", async () => {
    apiResponse = { ...msg({ id: "m-1" }), body: "Full body text" };
    const { result } = renderHook(() => useMailboxMessage("m-1"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.body).toBe("Full body text");
    expect(apiCalls).toEqual([{ method: "GET", path: "/me/inbox/m-1" }]);
  });

  it("surfaces an error when the detail fails the boundary parse", async () => {
    apiResponse = { ...msg({ id: "m-1" }), body: 42 };
    const { result } = renderHook(() => useMailboxMessage("m-1"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("does not fetch while no message is selected", () => {
    apiResponse = { ...msg({ id: "m-1" }), body: "x" };
    renderHook(() => useMailboxMessage(null), { wrapper: wrapper() });
    expect(apiCalls).toEqual([]);
  });
});
