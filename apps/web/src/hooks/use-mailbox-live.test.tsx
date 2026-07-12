/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import { useMailboxLive } from "./use-mailbox-live";
import { MAILBOX_QUERY_KEY } from "./use-mailbox";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners: Record<string, ((event: { data: string }) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data: string }) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  emit(type: string, data: string): void {
    for (const cb of this.listeners[type] ?? []) cb({ data });
  }

  close(): void {
    this.closed = true;
  }

  static latest(): FakeEventSource {
    const list = FakeEventSource.instances;
    const es = list[list.length - 1];
    if (es === undefined) throw new Error("no EventSource created");
    return es;
  }
}

const originalEventSource = globalThis.EventSource;

function installFakeEventSource(): void {
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource =
    FakeEventSource as unknown as typeof EventSource;
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  cleanup();
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
});

describe("useMailboxLive", () => {
  it("invalidates the mailbox query when a mailbox signal arrives", async () => {
    installFakeEventSource();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(MAILBOX_QUERY_KEY, [{ id: "stale" }]);

    renderHook(() => useMailboxLive(), { wrapper: wrapper(client) });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    act(() => {
      FakeEventSource.latest().emit(
        "mailbox",
        JSON.stringify({ type: "mailbox", id: "row-1" }),
      );
    });

    await waitFor(() =>
      expect(client.getQueryState(MAILBOX_QUERY_KEY)?.isInvalidated).toBe(true),
    );
  });

  it("does not invalidate before any signal arrives", () => {
    installFakeEventSource();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(MAILBOX_QUERY_KEY, [{ id: "stale" }]);

    renderHook(() => useMailboxLive(), { wrapper: wrapper(client) });

    expect(client.getQueryState(MAILBOX_QUERY_KEY)?.isInvalidated).toBe(false);
  });

  it("closes the stream connection on unmount", async () => {
    installFakeEventSource();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { unmount } = renderHook(() => useMailboxLive(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.latest();

    unmount();

    expect(es.closed).toBe(true);
  });
});
