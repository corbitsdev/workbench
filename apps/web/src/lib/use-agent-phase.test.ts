/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAgentPhase } from "./use-agent-phase";

// Drive useAgentPhase through the REAL instance-transport + shared-event-stream
// by stubbing the EventSource boundary, rather than module-mocking
// instance-transport. A local module mock leaks process-wide under bun and
// replaces the real module in instance-transport.test, so we stub the global
// network primitive instead (the pattern the rest of the suite uses).
class FakeEventSource {
  static open = new Set<FakeEventSource>();
  url: string;
  listeners: Record<string, (event: MessageEvent) => void> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.open.add(this);
  }

  addEventListener(name: string, cb: (event: MessageEvent) => void): void {
    this.listeners[name] = cb;
  }

  close(): void {
    FakeEventSource.open.delete(this);
  }
}

const originalEventSource = globalThis.EventSource;

function sourceFor(instanceId: string): FakeEventSource | undefined {
  return [...FakeEventSource.open].find((s) =>
    s.url.includes(`/instances/${instanceId}/events`),
  );
}

function emit(instanceId: string, event: unknown): void {
  const source = sourceFor(instanceId);
  if (!source) return;
  const frame = { data: JSON.stringify(event) } as MessageEvent;
  for (const listener of Object.values(source.listeners)) listener(frame);
}

const target = { instanceId: "inst_a", tenantId: "tenant_1" };

beforeEach(() => {
  (
    globalThis as unknown as {
      window: { happyDOM: { setURL: (u: string) => void } };
    }
  ).window.happyDOM.setURL("http://localhost/");
  FakeEventSource.open = new Set<FakeEventSource>();
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  globalThis.EventSource = originalEventSource;
});

describe("useAgentPhase", () => {
  it("returns null and opens no subscription when there is no agent to track", () => {
    const { result } = renderHook(() => useAgentPhase(null));
    expect(result.current).toBeNull();
    expect(FakeEventSource.open.size).toBe(0);
  });

  it("reports idle for a running agent with no live stream", () => {
    const { result } = renderHook(() => useAgentPhase(target));
    expect(result.current).toBe("idle");
  });

  it("reports thinking while the agent streams reasoning", () => {
    const { result } = renderHook(() => useAgentPhase(target));
    act(() => {
      emit("inst_a", {
        type: "inference.thinking.delta",
        data: { partial: { thinking: "weighing options" } },
      });
    });
    expect(result.current).toBe("thinking");
  });

  it("reports thinking during a tool call (active, no streamed text)", () => {
    const { result } = renderHook(() => useAgentPhase(target));
    act(() => {
      emit("inst_a", { type: "inference.start" });
    });
    expect(result.current).toBe("thinking");
  });

  it("reports typing once visible answer text streams", () => {
    const { result } = renderHook(() => useAgentPhase(target));
    act(() => {
      emit("inst_a", {
        type: "inference.text.delta",
        data: { partial: { text: "Here" } },
      });
    });
    expect(result.current).toBe("typing");
  });

  it("returns to idle when the turn commits", () => {
    const { result } = renderHook(() => useAgentPhase(target));
    act(() => {
      emit("inst_a", {
        type: "inference.text.delta",
        data: { partial: { text: "Here" } },
      });
    });
    expect(result.current).toBe("typing");
    act(() => {
      emit("inst_a", { type: "turn.committed" });
    });
    expect(result.current).toBe("idle");
  });

  it("recovers to idle when a turn fails mid-reasoning", () => {
    const { result } = renderHook(() => useAgentPhase(target));
    act(() => {
      emit("inst_a", { type: "inference.start" });
      emit("inst_a", {
        type: "inference.thinking.delta",
        data: { partial: { thinking: "working" } },
      });
    });
    expect(result.current).toBe("thinking");
    act(() => {
      emit("inst_a", { type: "reactor.error" });
    });
    expect(result.current).toBe("idle");
  });

  it("tears down its subscription on unmount", () => {
    const { unmount } = renderHook(() => useAgentPhase(target));
    expect(FakeEventSource.open.size).toBe(1);
    unmount();
    expect(FakeEventSource.open.size).toBe(0);
  });

  it("tracks two agents independently without disturbing each other", () => {
    const a = renderHook(() => useAgentPhase(target));
    const b = renderHook(() =>
      useAgentPhase({ instanceId: "inst_b", tenantId: "tenant_1" }),
    );

    act(() => {
      emit("inst_b", {
        type: "inference.text.delta",
        data: { partial: { text: "reply" } },
      });
    });

    expect(a.result.current).toBe("idle");
    expect(b.result.current).toBe("typing");

    // Unmounting one leaves the other's subscription intact.
    a.unmount();
    expect(sourceFor("inst_b")).toBeTruthy();
  });
});
