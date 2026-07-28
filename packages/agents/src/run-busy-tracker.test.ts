import { describe, expect, it } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { createRunBusyTracker } from "./run-busy-tracker";

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

describe("createRunBusyTracker", () => {
  it("starts idle", () => {
    const { transport } = fakeTransport();
    const tracker = createRunBusyTracker(transport, params);
    expect(tracker.busy).toBe(false);
  });

  it("is busy once inference starts", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createRunBusyTracker(transport, params);
    emit({ type: "inference.start" });
    expect(tracker.busy).toBe(true);
  });

  it("stays busy across a multi-turn tool loop (no flicker on turn.committed)", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createRunBusyTracker(transport, params);
    emit({ type: "inference.start" });
    emit({ type: "inference.tool" });
    emit({ type: "tool.start" });
    emit({ type: "tool.running" });
    emit({
      type: "inference.done",
      data: { turn: { content: [{ type: "tool_call" }] } },
    });
    emit({ type: "turn.committed" });
    expect(tracker.busy).toBe(true);
    emit({ type: "inference.start" });
    emit({ type: "inference.text.delta", data: { partial: { text: "Done" } } });
    expect(tracker.busy).toBe(true);
  });

  it("stays busy while answer text streams (activity pill would be idle)", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createRunBusyTracker(transport, params);
    emit({ type: "inference.start" });
    emit({ type: "inference.text.delta", data: { partial: { text: "Hello" } } });
    expect(tracker.busy).toBe(true);
  });

  it("clears on connector.reply (cycle finished with a reply)", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createRunBusyTracker(transport, params);
    emit({ type: "inference.start" });
    emit({ type: "inference.text.delta", data: { partial: { text: "Hi" } } });
    emit({ type: "turn.committed" });
    emit({ type: "connector.reply" });
    expect(tracker.busy).toBe(false);
  });

  it("clears on content-less inference.done (wait decision, CL-3871)", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createRunBusyTracker(transport, params);
    emit({ type: "inference.start" });
    expect(tracker.busy).toBe(true);
    emit({ type: "inference.done", data: { turn: { content: [] } } });
    expect(tracker.busy).toBe(false);
  });

  it("stays busy on inference.done when the turn produced content", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createRunBusyTracker(transport, params);
    emit({ type: "inference.start" });
    emit({
      type: "inference.done",
      data: { turn: { content: [{ type: "text", text: "ok" }] } },
    });
    expect(tracker.busy).toBe(true);
  });

  it("clears on reactor.done, reactor.abort, reactor.error, inference.error", () => {
    for (const type of [
      "reactor.done",
      "reactor.abort",
      "reactor.error",
      "inference.error",
    ] as const) {
      const { transport, emit } = fakeTransport();
      const tracker = createRunBusyTracker(transport, params);
      emit({ type: "inference.start" });
      expect(tracker.busy).toBe(true);
      emit({ type });
      expect(tracker.busy).toBe(false);
    }
  });

  it("stays busy through approval gates so the composer queue does not drain", () => {
    const { transport, emit } = fakeTransport();
    const tracker = createRunBusyTracker(transport, params);
    emit({ type: "inference.start" });
    emit({ type: "inference.tool" });
    expect(tracker.busy).toBe(true);

    emit({
      type: "reactor.gate.blocked",
      data: { reason: "approval", gateId: "g1" },
    });
    expect(tracker.busy).toBe(true);

    emit({ type: "reactor.gate.cleared", data: { gateId: "g1" } });
    expect(tracker.busy).toBe(true);

    emit({ type: "connector.reply" });
    expect(tracker.busy).toBe(false);
  });

  it("invokes onUpdate only when busy flips", () => {
    const { transport, emit } = fakeTransport();
    let updates = 0;
    createRunBusyTracker(transport, params, () => {
      updates += 1;
    });
    emit({ type: "inference.start" });
    expect(updates).toBe(1);
    emit({ type: "inference.tool" });
    expect(updates).toBe(1);
    emit({ type: "turn.committed" });
    expect(updates).toBe(1);
    emit({ type: "connector.reply" });
    expect(updates).toBe(2);
  });

  it("stops the underlying subscription", () => {
    const { transport, stopped } = fakeTransport();
    const tracker = createRunBusyTracker(transport, params);
    tracker.stop();
    expect(stopped()).toBe(true);
  });
});
