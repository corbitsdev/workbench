import { describe, test, expect } from "bun:test";

import type { InferenceEvent } from "@intx/types/runtime";
import {
  assistantLoopInterruptMessage,
  createAssistantLoopGuard,
} from "@workbench/hub-agent";

import { observeInferenceEventForAssistantLoopGuard } from "./assistant-loop-guard-wiring";

function inferenceDone(seq: number, text: string): InferenceEvent {
  return {
    type: "inference.done",
    seq,
    data: {
      turn: {
        role: "assistant",
        content: [{ type: "text", text }],
        model: "test-model",
        timestamp: seq,
      },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { sourceId: "step-1", provider: "anthropic", model: "m" },
    },
  };
}

function nonDoneEvent(seq: number): InferenceEvent {
  return { type: "inference.start", seq, data: { model: "m" } };
}

describe("observeInferenceEventForAssistantLoopGuard", () => {
  test("publishes the interrupt notice and drains on the third identical cycle", () => {
    const guard = createAssistantLoopGuard();
    const published: InferenceEvent[] = [];
    const drainCalls: number[] = [];
    const hooks = {
      guard,
      sessionKey: "addr-1",
      publish: (event: InferenceEvent) => published.push(event),
      drain: (deadlineMs: number) => {
        drainCalls.push(deadlineMs);
        return Promise.resolve();
      },
    };

    observeInferenceEventForAssistantLoopGuard(inferenceDone(1, "loop"), hooks);
    observeInferenceEventForAssistantLoopGuard(inferenceDone(2, "loop"), hooks);
    expect(published).toHaveLength(0);
    expect(drainCalls).toHaveLength(0);

    observeInferenceEventForAssistantLoopGuard(inferenceDone(3, "loop"), hooks);

    expect(published).toHaveLength(1);
    const event = published[0];
    if (event === undefined || event.type !== "inference.error") {
      throw new Error("expected a published inference.error event");
    }
    expect(event.data.error.category).toBe("aborted");
    expect(event.data.error.message).toBe(assistantLoopInterruptMessage(3));
    expect(drainCalls).toEqual([0]);
  });

  test("never trips on a non-looping sequence of different text", () => {
    const guard = createAssistantLoopGuard();
    const published: InferenceEvent[] = [];
    const drainCalls: number[] = [];
    const hooks = {
      guard,
      sessionKey: "addr-1",
      publish: (event: InferenceEvent) => published.push(event),
      drain: (deadlineMs: number) => {
        drainCalls.push(deadlineMs);
        return Promise.resolve();
      },
    };

    observeInferenceEventForAssistantLoopGuard(
      inferenceDone(1, "attempt one"),
      hooks,
    );
    observeInferenceEventForAssistantLoopGuard(
      inferenceDone(2, "attempt two"),
      hooks,
    );
    observeInferenceEventForAssistantLoopGuard(
      inferenceDone(3, "attempt three"),
      hooks,
    );

    expect(published).toHaveLength(0);
    expect(drainCalls).toHaveLength(0);
  });

  test("never trips on different tool calls even with identical text", () => {
    const guard = createAssistantLoopGuard();
    const published: InferenceEvent[] = [];
    const hooks = {
      guard,
      sessionKey: "addr-1",
      publish: (event: InferenceEvent) => published.push(event),
      drain: () => Promise.resolve(),
    };
    function withToolCall(seq: number, query: string): InferenceEvent {
      return {
        type: "inference.done",
        seq,
        data: {
          turn: {
            role: "assistant",
            content: [
              { type: "text", text: "working on it" },
              {
                type: "tool_call",
                id: `call-${String(seq)}`,
                name: "search",
                arguments: { q: query },
              },
            ],
            model: "test-model",
            timestamp: seq,
          },
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            thinking: 0,
          },
          source: { sourceId: "step-1", provider: "anthropic", model: "m" },
        },
      };
    }

    observeInferenceEventForAssistantLoopGuard(withToolCall(1, "one"), hooks);
    observeInferenceEventForAssistantLoopGuard(withToolCall(2, "two"), hooks);
    observeInferenceEventForAssistantLoopGuard(withToolCall(3, "three"), hooks);

    expect(published).toHaveLength(0);
  });

  test("a guard reset between identical cycles prevents a trip", () => {
    const guard = createAssistantLoopGuard();
    const published: InferenceEvent[] = [];
    const hooks = {
      guard,
      sessionKey: "addr-1",
      publish: (event: InferenceEvent) => published.push(event),
      drain: () => Promise.resolve(),
    };

    observeInferenceEventForAssistantLoopGuard(inferenceDone(1, "same"), hooks);
    observeInferenceEventForAssistantLoopGuard(inferenceDone(2, "same"), hooks);
    guard.reset("addr-1");
    observeInferenceEventForAssistantLoopGuard(inferenceDone(3, "same"), hooks);
    observeInferenceEventForAssistantLoopGuard(inferenceDone(4, "same"), hooks);

    expect(published).toHaveLength(0);
  });

  test("ignores every event type other than inference.done", () => {
    const guard = createAssistantLoopGuard({ threshold: 1 });
    const published: InferenceEvent[] = [];
    const hooks = {
      guard,
      sessionKey: "addr-1",
      publish: (event: InferenceEvent) => published.push(event),
      drain: () => Promise.resolve(),
    };

    observeInferenceEventForAssistantLoopGuard(nonDoneEvent(1), hooks);
    observeInferenceEventForAssistantLoopGuard(nonDoneEvent(2), hooks);
    observeInferenceEventForAssistantLoopGuard(nonDoneEvent(3), hooks);

    expect(published).toHaveLength(0);
  });

  test("concurrent agents keyed by different sessionKeys never share run state", () => {
    const guard = createAssistantLoopGuard();
    const published: { sessionKey: string; event: InferenceEvent }[] = [];
    function hooksFor(sessionKey: string) {
      return {
        guard,
        sessionKey,
        publish: (event: InferenceEvent) =>
          published.push({ sessionKey, event }),
        drain: () => Promise.resolve(),
      };
    }

    observeInferenceEventForAssistantLoopGuard(
      inferenceDone(1, "same"),
      hooksFor("addr-a"),
    );
    observeInferenceEventForAssistantLoopGuard(
      inferenceDone(1, "same"),
      hooksFor("addr-b"),
    );
    observeInferenceEventForAssistantLoopGuard(
      inferenceDone(2, "same"),
      hooksFor("addr-a"),
    );
    observeInferenceEventForAssistantLoopGuard(
      inferenceDone(2, "same"),
      hooksFor("addr-b"),
    );

    expect(published).toHaveLength(0);

    observeInferenceEventForAssistantLoopGuard(
      inferenceDone(3, "same"),
      hooksFor("addr-b"),
    );

    expect(published).toHaveLength(1);
    expect(published[0]?.sessionKey).toBe("addr-b");
  });

  test("a drain failure is logged, not thrown", () => {
    const guard = createAssistantLoopGuard();
    const published: InferenceEvent[] = [];
    const hooks = {
      guard,
      sessionKey: "addr-1",
      publish: (event: InferenceEvent) => published.push(event),
      drain: () => Promise.reject(new Error("supervisor mid-teardown")),
    };

    expect(() => {
      observeInferenceEventForAssistantLoopGuard(inferenceDone(1, "x"), hooks);
      observeInferenceEventForAssistantLoopGuard(inferenceDone(2, "x"), hooks);
      observeInferenceEventForAssistantLoopGuard(inferenceDone(3, "x"), hooks);
    }).not.toThrow();
    expect(published).toHaveLength(1);
  });
});
