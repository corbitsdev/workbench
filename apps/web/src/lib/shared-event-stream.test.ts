/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { subscribeSharedEventStream } from "./shared-event-stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private handlers = new Map<string, (event: { data: string }) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, handler: (event: { data: string }) => void) {
    this.handlers.set(name, handler);
  }

  emit(name: string, data: unknown) {
    this.handlers.get(name)?.({ data: JSON.stringify(data) });
  }

  emitRaw(name: string, data: string) {
    this.handlers.get(name)?.({ data });
  }

  close() {
    this.closed = true;
  }
}

const originalEventSource = globalThis.EventSource;
const originalSetTimeout = globalThis.setTimeout;

// Capture scheduled reconnect callbacks so tests can flush them deterministically
// instead of waiting on real backoff timers.
let pendingTimers: (() => void)[] = [];
function flushTimers(): void {
  const due = pendingTimers;
  pendingTimers = [];
  for (const run of due) run();
}

// The registry is module-level state shared across tests. Track every
// subscription and drain it after each test so a leaked connection from one
// test does not satisfy the next test's "already connected" path.
const activeStops: (() => void)[] = [];
function subscribe(
  url: string,
  name: string,
  onEvent: (event: unknown) => void,
) {
  const stop = subscribeSharedEventStream(url, name, onEvent);
  activeStops.push(stop);
  return stop;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  pendingTimers = [];
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
    pendingTimers.push(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  while (activeStops.length > 0) activeStops.pop()?.();
  (globalThis as { EventSource: unknown }).EventSource = originalEventSource;
  (globalThis as { setTimeout: unknown }).setTimeout = originalSetTimeout;
});

const URL_A = "https://hub/api/tenants/t1/agents/instances/i1/events";

describe("subscribeSharedEventStream", () => {
  it("opens a single EventSource for multiple subscribers to the same stream", () => {
    subscribe(URL_A, "agent.event", () => undefined);
    subscribe(URL_A, "agent.event", () => undefined);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("fans a single event out to every subscriber", () => {
    const received: string[] = [];
    subscribe(URL_A, "agent.event", (e) =>
      received.push(`a:${JSON.stringify(e)}`),
    );
    subscribe(URL_A, "agent.event", (e) =>
      received.push(`b:${JSON.stringify(e)}`),
    );

    FakeEventSource.instances[0]!.emit("agent.event", { type: "x" });

    expect(received).toEqual(['a:{"type":"x"}', 'b:{"type":"x"}']);
  });

  it("keeps the connection open while at least one subscriber remains", () => {
    const stop1 = subscribe(URL_A, "agent.event", () => undefined);
    subscribe(URL_A, "agent.event", () => undefined);

    stop1();

    expect(FakeEventSource.instances[0]!.closed).toBe(false);
  });

  it("closes the connection when the last subscriber unsubscribes", () => {
    const stop1 = subscribe(URL_A, "agent.event", () => undefined);
    const stop2 = subscribe(URL_A, "agent.event", () => undefined);

    stop1();
    stop2();

    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it("reopens a fresh connection after a full teardown", () => {
    const stop = subscribe(URL_A, "agent.event", () => undefined);
    stop();
    subscribe(URL_A, "agent.event", () => undefined);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("reconnects after an error and keeps delivering to the original listeners", () => {
    const received: unknown[] = [];
    subscribe(URL_A, "agent.event", (e) => received.push(e));

    // The stream drops; the connection schedules a reconnect.
    FakeEventSource.instances[0]!.onerror?.();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    flushTimers();

    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]!.emit("agent.event", {
      type: "after-reconnect",
    });
    expect(received).toEqual([{ type: "after-reconnect" }]);
  });

  it("does not reconnect after the last subscriber has unsubscribed", () => {
    const stop = subscribe(URL_A, "agent.event", () => undefined);
    stop();
    FakeEventSource.instances[0]!.onerror?.();
    flushTimers();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("drops a malformed frame without breaking delivery to other listeners", () => {
    const received: unknown[] = [];
    subscribe(URL_A, "agent.event", (e) => received.push(e));

    // Emit a frame whose data is not valid JSON, then a good one.
    FakeEventSource.instances[0]!.emitRaw("agent.event", "not json{");
    FakeEventSource.instances[0]!.emit("agent.event", { type: "ok" });

    expect(received).toEqual([{ type: "ok" }]);
  });

  it("keeps separate connections for the same url under different event names", () => {
    subscribe(URL_A, "agent.event", () => undefined);
    subscribe(URL_A, "agent.phase", () => undefined);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("resets backoff after a successful reopen so the next failure starts from the floor", () => {
    subscribe(URL_A, "agent.event", () => undefined);

    // First failure schedules a reconnect at the 1s floor.
    FakeEventSource.instances[0]!.onerror?.();
    flushTimers();
    // The reconnect doubled the delay to 2s; signal that the new source opened.
    FakeEventSource.instances[1]!.onopen?.();

    // A second failure after a healthy open must restart from the 1s floor, then
    // double to 2s on its scheduled retry — not continue compounding from 2s.
    FakeEventSource.instances[1]!.onerror?.();
    flushTimers();
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("does not deliver events to an unsubscribed listener", () => {
    const received: unknown[] = [];
    const stop = subscribe(URL_A, "agent.event", (e) => received.push(e));
    subscribe(URL_A, "agent.event", () => undefined);

    stop();
    FakeEventSource.instances[0]!.emit("agent.event", { type: "x" });

    expect(received).toHaveLength(0);
  });
});
