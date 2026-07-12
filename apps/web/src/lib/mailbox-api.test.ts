/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { subscribeMailboxEvents } from "./mailbox-api";

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

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
});

describe("subscribeMailboxEvents", () => {
  it("connects to the same-origin /api/v1/me/inbox/events URL", () => {
    installFakeEventSource();
    const unsubscribe = subscribeMailboxEvents(() => {});
    expect(FakeEventSource.latest().url).toContain("/api/v1/me/inbox/events");
    unsubscribe();
  });

  it("invokes onEvent for a well-formed mailbox frame", () => {
    installFakeEventSource();
    const received: unknown[] = [];
    const unsubscribe = subscribeMailboxEvents((e) => received.push(e));

    FakeEventSource.latest().emit(
      "mailbox",
      JSON.stringify({ type: "mailbox", id: "row-1" }),
    );

    expect(received).toEqual([{ type: "mailbox", id: "row-1" }]);
    unsubscribe();
  });

  it("drops a malformed frame instead of throwing", () => {
    installFakeEventSource();
    const received: unknown[] = [];
    const unsubscribe = subscribeMailboxEvents((e) => received.push(e));

    FakeEventSource.latest().emit("mailbox", JSON.stringify({ type: "bogus" }));

    expect(received).toEqual([]);
    unsubscribe();
  });

  it("closes the connection when the last subscriber unsubscribes", () => {
    installFakeEventSource();
    const unsubscribe = subscribeMailboxEvents(() => {});
    const es = FakeEventSource.latest();
    unsubscribe();
    expect(es.closed).toBe(true);
  });
});
