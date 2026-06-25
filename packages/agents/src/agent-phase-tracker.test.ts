import { describe, expect, it } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { createAgentPhaseTracker } from "./agent-phase-tracker";

function fakeTransport(): {
  transport: Transport;
  emit: (event: unknown) => void;
  stopped: () => boolean;
} {
  let listener: ((event: unknown) => void) | null = null;
  let stopped = false;
  const transport: Transport = {
    fetch: async () => undefined as never,
    subscribe(_path, onEvent) {
      listener = onEvent;
      return () => {
        stopped = true;
      };
    },
  };
  return {
    transport,
    emit: (event) => listener?.(event),
    stopped: () => stopped,
  };
}

const params = { tenantId: "t1", instanceId: "i1" };

describe("createAgentPhaseTracker", () => {
  it("starts idle", () => {
    const { transport } = fakeTransport();
    const tracker = createAgentPhaseTracker(transport, params);
    expect(tracker.phase).toBe("idle");
  });

  it("is thinking once inference starts, before any text or reasoning", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createAgentPhaseTracker(transport, params);
    emit({ type: "inference.start" });
    expect(tracker.phase).toBe("thinking");
  });

  it("stays thinking during a tool call (active, no streamed text)", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createAgentPhaseTracker(transport, params);
    emit({ type: "inference.start" });
    emit({ type: "inference.tool" });
    expect(tracker.phase).toBe("thinking");
  });

  it("is thinking while reasoning streams", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createAgentPhaseTracker(transport, params);
    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "hmm" } },
    });
    expect(tracker.phase).toBe("thinking");
  });

  it("is typing once visible answer text streams", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createAgentPhaseTracker(transport, params);
    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "hmm" } },
    });
    emit({ type: "inference.text.delta", data: { partial: { text: "Here" } } });
    expect(tracker.phase).toBe("typing");
  });

  it("returns to idle when the turn commits", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createAgentPhaseTracker(transport, params);
    emit({ type: "inference.start" });
    emit({ type: "inference.text.delta", data: { partial: { text: "Here" } } });
    emit({ type: "turn.committed" });
    expect(tracker.phase).toBe("idle");
  });

  it("recovers to idle when a turn fails mid-reasoning (no commit)", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createAgentPhaseTracker(transport, params);
    emit({ type: "inference.start" });
    emit({
      type: "inference.thinking.delta",
      data: { partial: { thinking: "working" } },
    });
    expect(tracker.phase).toBe("thinking");
    emit({ type: "reactor.error" });
    expect(tracker.phase).toBe("idle");
  });

  it("recovers to idle on inference.error", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createAgentPhaseTracker(transport, params);
    emit({ type: "inference.start" });
    emit({ type: "inference.error" });
    expect(tracker.phase).toBe("idle");
  });

  it("invokes onUpdate when the phase changes and not when it is unchanged", () => {
    const { transport, emit } = fakeTransport();
    let updates = 0;
    const tracker = createAgentPhaseTracker(transport, params, () => {
      updates += 1;
    });
    emit({ type: "inference.start" });
    expect(updates).toBe(1);
    emit({ type: "inference.tool" });
    expect(updates).toBe(1);
    expect(tracker.phase).toBe("thinking");
  });

  it("stops the underlying subscription", () => {
    const { transport, stopped } = fakeTransport();
    const tracker = createAgentPhaseTracker(transport, params);
    tracker.stop();
    expect(stopped()).toBe(true);
  });
});
