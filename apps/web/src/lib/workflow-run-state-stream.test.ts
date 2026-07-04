/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, jest } from "bun:test";
import {
  __resetWorkflowRunStateStreamsForTests,
  subscribeWorkflowRunStateStream,
  type RunStateStreamHandlers,
} from "./workflow-run-state-stream";
import type { LogRunState } from "./run-state-adapter";

// Controllable EventSource stand-in: happy-dom ships none, so the module's real
// `new EventSource(...)` path is exercised against this fake, which lets a test
// drive frames, opens and errors deterministically.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners: Record<string, ((event: { data: string }) => void)[]> = {};

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data: string }) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  emitMessage(data: string): void {
    for (const cb of this.listeners.message ?? []) cb({ data });
  }

  emitError(): void {
    this.onerror?.();
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

function runState(phase: LogRunState["phase"], lastSeq: number): LogRunState {
  return { runId: "wfr_1", phase, lastSeq, steps: [] };
}

const noopHandlers: RunStateStreamHandlers = {
  onState: () => undefined,
  onError: () => undefined,
};

afterEach(() => {
  __resetWorkflowRunStateStreamsForTests();
  jest.useRealTimers();
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
});

describe("subscribeWorkflowRunStateStream", () => {
  it("parses and delivers each validated RunState frame", () => {
    installFakeEventSource();
    const received: LogRunState[] = [];
    subscribeWorkflowRunStateStream("http://h/s", {
      onState: (s) => received.push(s),
      onError: () => undefined,
    });

    const es = FakeEventSource.latest();
    es.emitMessage(JSON.stringify(runState("pending", 0)));
    es.emitMessage(JSON.stringify(runState("running", 2)));

    expect(received.map((s) => s.phase)).toEqual(["pending", "running"]);
    expect(received[1]?.lastSeq).toBe(2);
    expect(es.withCredentials).toBe(true);
  });

  it("drops a malformed frame instead of throwing", () => {
    installFakeEventSource();
    const received: LogRunState[] = [];
    subscribeWorkflowRunStateStream("http://h/s", {
      onState: (s) => received.push(s),
      onError: () => undefined,
    });
    const es = FakeEventSource.latest();
    es.emitMessage("not json{");
    es.emitMessage(JSON.stringify({ runId: "x", phase: "bogus", steps: [] }));
    es.emitMessage(JSON.stringify(runState("running", 1)));
    expect(received.map((s) => s.phase)).toEqual(["running"]);
  });

  it("shares one EventSource across subscribers and closes on last unsubscribe", () => {
    installFakeEventSource();
    const a: LogRunState[] = [];
    const b: LogRunState[] = [];
    const unsubA = subscribeWorkflowRunStateStream("http://h/s", {
      onState: (s) => a.push(s),
      onError: () => undefined,
    });
    const unsubB = subscribeWorkflowRunStateStream("http://h/s", {
      onState: (s) => b.push(s),
      onError: () => undefined,
    });

    expect(FakeEventSource.instances.length).toBe(1);
    const es = FakeEventSource.latest();
    es.emitMessage(JSON.stringify(runState("running", 1)));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    unsubA();
    expect(es.closed).toBe(false);
    unsubB();
    expect(es.closed).toBe(true);
  });

  it("reports rising consecutive errors and reconnects with backoff, resetting on a frame", () => {
    jest.useFakeTimers();
    installFakeEventSource();
    const errorCounts: number[] = [];
    subscribeWorkflowRunStateStream("http://h/s", {
      onState: () => undefined,
      onError: (n) => errorCounts.push(n),
    });

    FakeEventSource.latest().emitError();
    expect(errorCounts).toEqual([1]);
    // A native EventSource would give up on the HTTP error; the module schedules
    // its own reconnect, creating a fresh source.
    jest.advanceTimersByTime(1000);
    expect(FakeEventSource.instances.length).toBe(2);

    FakeEventSource.latest().emitError();
    expect(errorCounts).toEqual([1, 2]);
    jest.advanceTimersByTime(2000);
    expect(FakeEventSource.instances.length).toBe(3);

    // A successful frame resets the streak.
    FakeEventSource.latest().emitMessage(
      JSON.stringify(runState("running", 1)),
    );
    FakeEventSource.latest().emitError();
    expect(errorCounts).toEqual([1, 2, 1]);
  });

  it("no-ops without a global EventSource", () => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource?: unknown }).EventSource = undefined;
    const unsub = subscribeWorkflowRunStateStream("http://h/s", noopHandlers);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(() => unsub()).not.toThrow();
  });
});
