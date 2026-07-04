/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import { useWorkflowRunState } from "./use-workflow";
import { __resetWorkflowRunStateStreamsForTests } from "../lib/workflow-run-state-stream";
import type { LogRunState } from "../lib/run-state-adapter";

// A controllable EventSource so the hook's SSE subscription can be driven with a
// deterministic sequence of RunState frames — asserting the run view tracks
// execution live as events arrive (CL-2779), and that a broken stream degrades
// to a single fallback read, not a re-armed poll.
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
const originalFetch = globalThis.fetch;

function installFakeEventSource(): void {
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource =
    FakeEventSource as unknown as typeof EventSource;
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function running(steps: LogRunState["steps"]): LogRunState {
  return { runId: "wfr_1", phase: "running", lastSeq: steps.length, steps };
}

function step(
  stepId: string,
  phase: LogRunState["steps"][number]["phase"],
): LogRunState["steps"][number] {
  return { stepId, phase, stepType: "agent", currentAttempt: 1 };
}

afterEach(() => {
  cleanup();
  __resetWorkflowRunStateStreamsForTests();
  jest.useRealTimers();
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  globalThis.fetch = originalFetch;
});

describe("useWorkflowRunState live SSE", () => {
  it("advances the run view live as RunState frames arrive", async () => {
    installFakeEventSource();
    // The one-shot initial /state fetch is not the driver here — reject it so
    // ONLY the stream populates the view, proving live tracking.
    globalThis.fetch = (() =>
      Promise.reject(new Error("state not ready"))) as unknown as typeof fetch;

    const { result } = renderHook(() => useWorkflowRunState("wfr_1", "tn-x"), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.latest();

    act(() => {
      es.emitMessage(JSON.stringify(running([step("intake", "in-flight")])));
    });
    await waitFor(() =>
      expect(result.current.data?.steps[0]?.phase).toBe("in-flight"),
    );

    act(() => {
      es.emitMessage(
        JSON.stringify(
          running([step("intake", "completed"), step("web", "in-flight")]),
        ),
      );
    });
    await waitFor(() =>
      expect(result.current.data?.steps[1]?.phase).toBe("in-flight"),
    );
    expect(result.current.data?.steps[0]?.phase).toBe("completed");

    act(() => {
      es.emitMessage(
        JSON.stringify({
          runId: "wfr_1",
          phase: "completed",
          lastSeq: 9,
          steps: [step("intake", "completed"), step("web", "completed")],
        } satisfies LogRunState),
      );
    });
    await waitFor(() => expect(result.current.data?.phase).toBe("completed"));
  });

  it("re-issues the degraded /state read every Nth error while the stream stays blocked, and stops once terminal", async () => {
    jest.useFakeTimers();
    installFakeEventSource();
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      // A persistently blocked stream: every read fails, so `onState` never
      // fires and the error count keeps climbing. We count the degraded /state
      // reads the hook issues on the error-gated cadence.
      return Promise.reject(new Error("state not ready"));
    }) as unknown as typeof fetch;

    renderHook(() => useWorkflowRunState("wfr_1", "tn-x"), {
      wrapper: wrapper(),
    });

    // Effect + initial fetch settle under fake timers.
    await act(async () => {
      await Promise.resolve();
    });
    const afterMount = fetchCalls;
    expect(FakeEventSource.instances.length).toBe(1);

    // Advancing past MAX_RETRY_DELAY_MS always flushes the pending reconnect
    // regardless of the current backoff, so we don't couple the test to exact
    // delays.
    const errorAndReconnect = async () => {
      act(() => FakeEventSource.latest().emitError());
      act(() => jest.advanceTimersByTime(30_000));
      await act(async () => {
        await Promise.resolve();
      });
    };

    // Errors 1 and 2: below the cadence, no degraded read yet.
    await errorAndReconnect();
    await errorAndReconnect();
    expect(fetchCalls).toBe(afterMount);

    // Error 3: first degraded read.
    await errorAndReconnect();
    expect(fetchCalls).toBe(afterMount + 1);

    // Errors 4 and 5: none; error 6: a SECOND degraded read. The fallback
    // re-fires — it does not freeze on the first snapshot — so a still-running
    // blocked run keeps advancing.
    await errorAndReconnect();
    await errorAndReconnect();
    await errorAndReconnect();
    expect(fetchCalls).toBe(afterMount + 2);

    // The run reaches a terminal state (a frame finally lands): the stream is
    // disabled and torn down.
    act(() =>
      FakeEventSource.latest().emitMessage(
        JSON.stringify({
          runId: "wfr_1",
          phase: "completed",
          lastSeq: 9,
          steps: [step("intake", "completed")],
        } satisfies LogRunState),
      ),
    );
    // Flush the setQueryData notification (React Query batches it on a timer),
    // the terminal re-render, and the resulting effect cleanup (unsubscribe).
    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(FakeEventSource.latest().closed).toBe(true);
    const readsAtTerminal = fetchCalls;

    // Continued errors after terminal drive NO further degraded read — the
    // subscription is gone (three more errors would otherwise cross the cadence
    // again and re-fetch).
    await errorAndReconnect();
    await errorAndReconnect();
    await errorAndReconnect();
    expect(fetchCalls).toBe(readsAtTerminal);
  });
});
