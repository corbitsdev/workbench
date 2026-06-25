/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  readLastActiveThreadId,
  resolveActiveThread,
  useAutoTitleFirstMessage,
  writeLastActiveThreadId,
} from "./use-myra-threads";
import type { MyraThread } from "../lib/hub-api";

const thread = (id: string): MyraThread => ({
  id,
  instanceId: `inst-${id}`,
  label: `Chat ${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const threads = [thread("a"), thread("b"), thread("c")];

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("last-active thread storage", () => {
  it("round-trips the last-active id", () => {
    expect(readLastActiveThreadId()).toBeNull();
    writeLastActiveThreadId("b");
    expect(readLastActiveThreadId()).toBe("b");
  });
});

describe("resolveActiveThread", () => {
  it("returns null when there are no threads", () => {
    expect(resolveActiveThread([])).toBeNull();
  });

  it("prefers an explicit id that exists", () => {
    writeLastActiveThreadId("c");
    expect(resolveActiveThread(threads, "b")?.id).toBe("b");
  });

  it("falls back to the stored last-active id when explicit id is absent or unknown", () => {
    writeLastActiveThreadId("c");
    expect(resolveActiveThread(threads, "does-not-exist")?.id).toBe("c");
    expect(resolveActiveThread(threads)?.id).toBe("c");
  });

  it("falls back to the first thread when nothing else matches", () => {
    writeLastActiveThreadId("gone");
    expect(resolveActiveThread(threads)?.id).toBe("a");
  });
});

describe("useAutoTitleFirstMessage", () => {
  const defaultThread: MyraThread = {
    id: "thr-1",
    instanceId: "inst-1",
    label: "Chat",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const fetchMock = mock(
    async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ thread: { ...defaultThread, label: "Q3 pricing" } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );
  const originalFetch = globalThis.fetch;

  function renderTitleHook(
    active: MyraThread | null,
    messages: { role: string }[],
  ) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    return renderHook(() => useAutoTitleFirstMessage(active, messages), {
      wrapper,
    });
  }

  function titleCalls(): [string, RequestInit?][] {
    return fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith("/title"),
    );
  }

  beforeEach(() => {
    fetchMock.mockClear();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("posts the first message to the title endpoint for a default-labelled thread", async () => {
    const { result } = renderTitleHook(defaultThread, []);
    act(() => result.current("How should we price Q3?"));
    await waitFor(() => expect(titleCalls()).toHaveLength(1));

    const [url, init] = titleCalls()[0] as [string, RequestInit];
    expect(url).toContain("/me/myra/threads/thr-1/title");
    expect(JSON.parse(init.body as string)).toEqual({
      firstMessage: "How should we price Q3?",
    });
  });

  it("skips a thread whose label is already custom", async () => {
    const { result } = renderTitleHook(
      { ...defaultThread, label: "Renamed by user" },
      [],
    );
    act(() => result.current("hello"));
    await Promise.resolve();
    expect(titleCalls()).toHaveLength(0);
  });

  it("skips when a prior user turn already exists in the stream", async () => {
    const { result } = renderTitleHook(defaultThread, [{ role: "user" }]);
    act(() => result.current("second message"));
    await Promise.resolve();
    expect(titleCalls()).toHaveLength(0);
  });

  it("fires at most once per thread", async () => {
    const { result } = renderTitleHook(defaultThread, []);
    act(() => result.current("first"));
    await waitFor(() => expect(titleCalls()).toHaveLength(1));
    act(() => result.current("again"));
    await Promise.resolve();
    expect(titleCalls()).toHaveLength(1);
  });
});
