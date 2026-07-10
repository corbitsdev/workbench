/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({ activeTenantId: "tnt_child" }),
}));
import {
  markTitlingActive,
  readLastActiveThreadId,
  resolveActiveThread,
  TITLE_POLL_INTERVAL_MS,
  titlePollInterval,
  useAutoTitleFirstMessage,
  useGenerateMyraThreadTitle,
  useMyraThreads,
  writeLastActiveThreadId,
} from "./use-myra-threads";
import type { MyraThread, MyraThreadListItem } from "../lib/hub-api";

const thread = (id: string): MyraThread => ({
  id,
  instanceId: `inst-${id}`,
  label: `Chat ${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
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

describe("title polling gate (CL-2872)", () => {
  const item = (label: string): MyraThreadListItem => ({
    id: "thr-1",
    instanceId: "inst-1",
    label,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
  });

  it("does not poll a tenant with no title in flight", () => {
    expect(titlePollInterval("tnt_idle", undefined, 1000)).toBe(false);
    expect(titlePollInterval(null, undefined, 1000)).toBe(false);
  });

  it("keeps polling while the label is still default or the optimistic fallback", () => {
    const start = 1_000_000;
    markTitlingActive("tnt_a", "thr-1", "How should we price", start);

    // Still the default label — title has not landed.
    expect(titlePollInterval("tnt_a", [item("Chat")], start + 1_000)).toBe(
      TITLE_POLL_INTERVAL_MS,
    );
    // Now the optimistic fallback we set — still not the generated title.
    expect(
      titlePollInterval("tnt_a", [item("How should we price")], start + 1_000),
    ).toBe(TITLE_POLL_INTERVAL_MS);
  });

  it("early-stops the moment the generated title replaces the fallback", () => {
    const start = 1_000_000;
    markTitlingActive("tnt_b", "thr-1", "How should we price", start);
    expect(
      titlePollInterval("tnt_b", [item("Enterprise pricing")], start + 1_000),
    ).toBe(false);
    // Pruned: a later check without a fresh mark stays stopped.
    expect(titlePollInterval("tnt_b", [item("Chat")], start + 1_000)).toBe(
      false,
    );
  });

  it("stops (and prunes) at the window ceiling even if the title never lands", () => {
    const start = 1_000_000;
    markTitlingActive("tnt_c", "thr-1", "How should we price", start);
    expect(
      titlePollInterval("tnt_c", [item("Chat")], start + 10 * 60_000),
    ).toBe(false);
    expect(titlePollInterval("tnt_c", [item("Chat")], start + 1_000)).toBe(
      false,
    );
  });
});

describe("useMyraThreads title polling (CL-2872)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("refetches the list while titling is active and surfaces the late title", async () => {
    let listCalls = 0;
    const pollFetch = mock(async (url: string, _init?: RequestInit) => {
      if (!String(url).endsWith("/me/myra/threads")) {
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      listCalls += 1;
      // The title lands on a later poll, not the first fetch — exactly the race
      // the single onSettled refetch used to lose.
      const label = listCalls >= 2 ? "Enterprise pricing" : "Chat";
      return new Response(
        JSON.stringify({
          threads: [
            {
              id: "thr-1",
              instanceId: "inst-1",
              label,
              createdAt: "2026-01-01T00:00:00.000Z",
              lastActivityAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          total: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = pollFetch as unknown as typeof fetch;

    // A title turn is in flight for the active tenant; the optimistic label is
    // neither the default nor the eventual generated title.
    markTitlingActive("tnt_child", "thr-1", "How can we cut onboarding");

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useMyraThreads(), { wrapper });

    await waitFor(() =>
      expect(result.current.data?.threads?.[0]?.label).toBe("Chat"),
    );
    // Without polling the label would stay "Chat" forever; the gate drives a
    // second fetch that surfaces the generated title.
    await waitFor(
      () =>
        expect(result.current.data?.threads?.[0]?.label).toBe(
          "Enterprise pricing",
        ),
      { timeout: 6_000 },
    );
  });

  it("surfaces the title through the real onMutate/onSettled trigger on an already-mounted list", async () => {
    // Drives the production order: the list is mounted and idle first, THEN the
    // title mutation fires — its onMutate opens the gate and its onSettled
    // invalidation kicks the query so refetchInterval begins polling. Guards the
    // load-bearing onSettled invalidation the pre-opened-gate test above skips.
    let listCalls = 0;
    const realOrderFetch = mock(async (url: string, _init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/title")) {
        return new Response(JSON.stringify({ thread: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/me/myra/threads")) {
        listCalls += 1;
        const label = listCalls >= 2 ? "Enterprise pricing" : "Chat";
        return new Response(
          JSON.stringify({
            threads: [
              {
                id: "thr-1",
                instanceId: "inst-1",
                label,
                createdAt: "2026-01-01T00:00:00.000Z",
                lastActivityAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            total: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = realOrderFetch as unknown as typeof fetch;

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(
      () => ({
        list: useMyraThreads(),
        title: useGenerateMyraThreadTitle(),
      }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.list.data?.threads?.[0]?.label).toBe("Chat"),
    );
    act(() =>
      result.current.title.mutate({
        id: "thr-1",
        firstMessage: "How should we price the enterprise tier",
      }),
    );
    await waitFor(
      () =>
        expect(result.current.list.data?.threads?.[0]?.label).toBe(
          "Enterprise pricing",
        ),
      { timeout: 6_000 },
    );
  });
});

describe("useAutoTitleFirstMessage", () => {
  const defaultThread: MyraThread = {
    id: "thr-1",
    instanceId: "inst-1",
    label: "Chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
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
    messages: { role: string; content: string }[] = [],
    messagesInstanceId: string | null = null,
  ) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    return renderHook(
      () => useAutoTitleFirstMessage(active, messages, messagesInstanceId),
      { wrapper },
    );
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
    const { result } = renderTitleHook(defaultThread);
    act(() => result.current("How should we price Q3?"));
    await waitFor(() => expect(titleCalls()).toHaveLength(1));

    const [url, init] = titleCalls()[0] as [string, RequestInit];
    expect(url).toContain("/me/myra/threads/thr-1/title");
    expect(JSON.parse(init.body as string)).toEqual({
      firstMessage: "How should we price Q3?",
    });
  });

  it("skips a thread whose label is already custom", async () => {
    const { result } = renderTitleHook({
      ...defaultThread,
      label: "Renamed by user",
    });
    act(() => result.current("hello"));
    await Promise.resolve();
    expect(titleCalls()).toHaveLength(0);
  });

  it("auto-titles from the transcript only when the session resolved to the active thread's instance", async () => {
    // Effect path: active thread's own instance, its own messages.
    renderTitleHook(
      defaultThread,
      [{ role: "user", content: "How should we price Q3?" }],
      defaultThread.instanceId,
    );
    await waitFor(() => expect(titleCalls()).toHaveLength(1));
    const [, init] = titleCalls()[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      firstMessage: "How should we price Q3?",
    });
  });

  it("does NOT auto-title a new thread from a previous thread's stale messages (CL-2882)", async () => {
    // The "+ New chat" race: active is the new default thread (instance B) but
    // the session still holds the previous thread's transcript (instance A), so
    // the messages' instance id does not match the active thread's.
    renderTitleHook(
      { ...defaultThread, id: "thr-new", instanceId: "inst-B" },
      [{ role: "user", content: "the previous thread's first message" }],
      "inst-A",
    );
    // The guard is a synchronous early-return inside the effect (which runs on
    // commit), so flushing a couple of microtasks is enough to prove it never
    // fired — there is no deferred/debounced path that could title on a later tick.
    await Promise.resolve();
    await Promise.resolve();
    expect(titleCalls()).toHaveLength(0);
  });

  it("re-titles a still-default thread that already has prior user turns", async () => {
    // Re-titling is driven only by the still-default label + the per-mount latch
    // — not by message history — so a thread that already has user turns still
    // gets titled while its label is "Chat" (CL-2449).
    const { result } = renderTitleHook(defaultThread);
    act(() => result.current("a later message in an existing thread"));
    await waitFor(() => expect(titleCalls()).toHaveLength(1));
  });

  it("fires at most once per thread", async () => {
    const { result } = renderTitleHook(defaultThread);
    act(() => result.current("first"));
    await waitFor(() => expect(titleCalls()).toHaveLength(1));
    act(() => result.current("again"));
    await Promise.resolve();
    expect(titleCalls()).toHaveLength(1);
  });

  it("does not retry when the hub accepts async titling (thread null)", async () => {
    const noopFetch = mock(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ thread: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = noopFetch as unknown as typeof fetch;
    const noopTitleCalls = () =>
      noopFetch.mock.calls.filter((call) => String(call[0]).endsWith("/title"));

    const { result } = renderTitleHook(defaultThread);
    act(() => result.current("first"));
    await waitFor(() => expect(noopTitleCalls()).toHaveLength(1));
    act(() => result.current("second"));
    await Promise.resolve();
    expect(noopTitleCalls()).toHaveLength(1);
  });

  it("optimistically updates the sidebar label before the title request completes", async () => {
    let resolveFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    const gatedFetch = mock(async (_url: string, _init?: RequestInit) => {
      await fetchGate;
      return new Response(JSON.stringify({ thread: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = gatedFetch as unknown as typeof fetch;

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    client.setQueryData(["myra-threads", "tnt_child"], {
      threads: [defaultThread],
      total: 1,
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(
      () => useAutoTitleFirstMessage(defaultThread),
      {
        wrapper,
      },
    );

    act(() => result.current("How should we price Q3?"));
    await waitFor(() => {
      const page = client.getQueryData<{ threads: MyraThread[] }>([
        "myra-threads",
        "tnt_child",
      ]);
      expect(page?.threads?.[0]?.label).toBe("How should we price Q3");
    });

    resolveFetch();
    await waitFor(() => expect(gatedFetch).toHaveBeenCalled());
  });

  it("retries on a later message when the title request errors", async () => {
    const errorFetch = mock(async (_url: string, _init?: RequestInit) => {
      throw new Error("network down");
    });
    globalThis.fetch = errorFetch as unknown as typeof fetch;
    const errorTitleCalls = () =>
      errorFetch.mock.calls.filter((call) =>
        String(call[0]).endsWith("/title"),
      );

    const { result } = renderTitleHook(defaultThread);
    act(() => result.current("first"));
    await waitFor(() => expect(errorTitleCalls()).toHaveLength(1));
    act(() => result.current("second"));
    await waitFor(() => expect(errorTitleCalls()).toHaveLength(2));
  });

  it("does not re-fire after a successful title (latch holds on success)", async () => {
    // Success returns a non-null thread; the id stays latched so a second
    // message does not waste another inference turn.
    const { result } = renderTitleHook(defaultThread);
    act(() => result.current("first"));
    await waitFor(() => expect(titleCalls()).toHaveLength(1));
    act(() => result.current("second"));
    await Promise.resolve();
    await Promise.resolve();
    expect(titleCalls()).toHaveLength(1);
  });
});
