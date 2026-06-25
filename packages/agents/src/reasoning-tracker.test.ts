import { describe, expect, it } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { createReasoningTracker } from "./reasoning-tracker";

function createFakeTransport(): {
  transport: Transport;
  emit: (event: unknown) => void;
  stopped: () => boolean;
} {
  let handler: ((event: unknown) => void) | null = null;
  let stopped = false;
  const transport: Transport = {
    fetch: async () => {
      throw new Error("not used");
    },
    subscribe: (_path, onEvent) => {
      handler = onEvent;
      return () => {
        stopped = true;
      };
    },
  };
  return {
    transport,
    emit: (event) => handler?.(event),
    stopped: () => stopped,
  };
}

const params = { tenantId: "t1", instanceId: "i1" };

const thinkingDelta = (thinking: string) => ({
  type: "inference.thinking.delta",
  data: { token: "x", partial: { text: "", thinking } },
});

const textDelta = (text: string) => ({
  type: "inference.text.delta",
  data: { token: "x", partial: { text } },
});

const turnCommitted = () => ({
  type: "turn.committed",
  data: { turnId: "x", text: "" },
});

describe("createReasoningTracker", () => {
  it("mirrors the current turn cumulative reasoning snapshot", () => {
    const { transport, emit } = createFakeTransport();
    const tracker = createReasoningTracker(transport, params);

    emit(thinkingDelta("Let me"));
    emit(thinkingDelta("Let me check"));
    emit(thinkingDelta("Let me check the call"));

    expect(tracker.text).toBe("Let me check the call");
  });

  it("ignores duplicate deltas (idempotent snapshot, no double-count)", () => {
    const { transport, emit } = createFakeTransport();
    let updates = 0;
    const tracker = createReasoningTracker(transport, params, () => {
      updates += 1;
    });

    emit(thinkingDelta("thinking..."));
    emit(thinkingDelta("thinking..."));

    expect(tracker.text).toBe("thinking...");
    expect(updates).toBe(1);
  });

  it("clears on turn.committed so reasoning does not bleed into the next turn", () => {
    const { transport, emit } = createFakeTransport();
    const tracker = createReasoningTracker(transport, params);

    emit(thinkingDelta("turn one reasoning"));
    expect(tracker.text).toBe("turn one reasoning");

    emit(turnCommitted());
    expect(tracker.text).toBe("");

    emit(thinkingDelta("turn two reasoning"));
    expect(tracker.text).toBe("turn two reasoning");
  });

  it("clears on a failed turn so a stale reasoning bubble does not linger", () => {
    const { transport, emit } = createFakeTransport();
    const tracker = createReasoningTracker(transport, params);

    emit(thinkingDelta("working on it"));
    expect(tracker.text).toBe("working on it");

    // Turn errors before it ever commits — without a reset this would pulse
    // "thinking" forever (CL-1660 review).
    emit({ type: "reactor.error" });
    expect(tracker.text).toBe("");
  });

  it("does not treat answer text deltas as reasoning", () => {
    const { transport, emit } = createFakeTransport();
    const tracker = createReasoningTracker(transport, params);

    emit(textDelta("the answer"));

    expect(tracker.text).toBe("");
  });

  it("stops the underlying subscription", () => {
    const { transport, emit, stopped } = createFakeTransport();
    const tracker = createReasoningTracker(transport, params);
    tracker.stop();
    emit(thinkingDelta("ignored after stop"));
    expect(stopped()).toBe(true);
  });
});
