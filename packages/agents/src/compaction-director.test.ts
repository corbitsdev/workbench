import { describe, expect, it } from "bun:test";
import { createDefaultDirector } from "@workbench/inference";
import type {
  AssistantTurn,
  ReactorAction,
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ToolCall,
  ToolDefinition,
  InferenceOptions,
} from "@intx/types/runtime";
import {
  wrapDirectorWithCompaction,
  COMPACTION_TRIGGER_THRESHOLD,
} from "./compaction-director";
import { SUMMARIZE_COMPACTOR_NAME } from "./summarize-compactor";

// `decide` may return a single action or an array; normalize so tests can
// treat the result uniformly as a list.
async function runDecide(
  d: ReactorDirector,
  event: ReactorInboundEvent,
  state: ReactorState,
  cap: ReactorCapabilities,
): Promise<ReactorAction[]> {
  const result = await d.decide(event, state, cap);
  return Array.isArray(result) ? result : [result];
}

const TEST_MODEL = "test-model";
const TEST_WINDOW = 100_000;

function windowFor(modelId: string): number {
  expect(modelId).toBe(TEST_MODEL);
  return TEST_WINDOW;
}

// Mirrors the real `createCapabilities` from @intx/inference: each action
// carries whatever arguments it is given, so wrapper behavior is observable
// on the returned actions.
function makeCapabilities(): ReactorCapabilities {
  return {
    infer(options?: InferenceOptions) {
      return {
        type: "infer" as const,
        ...(options !== undefined ? { options } : {}),
      };
    },
    executeTools(
      calls: ToolCall[],
      parallel?: boolean,
      addToHistory?: boolean,
    ) {
      return {
        type: "execute_tools" as const,
        calls,
        ...(parallel !== undefined ? { parallel } : {}),
        ...(addToHistory !== undefined ? { addToHistory } : {}),
      };
    },
    suspend(gate) {
      return { type: "suspend" as const, gate };
    },
    fork(mode, forkId) {
      return { type: "fork" as const, mode, forkId };
    },
    emit(eventType, data) {
      return { type: "emit" as const, eventType, data };
    },
    reply(content: string) {
      return { type: "reply" as const, content };
    },
    checkpoint(reason?: string) {
      return {
        type: "checkpoint" as const,
        message: reason !== undefined ? `checkpoint: ${reason}` : "checkpoint",
      };
    },
    compact(compactor: string, reason: string) {
      return { type: "compact" as const, compactor, reason };
    },
    wait() {
      return { type: "wait" as const };
    },
    done() {
      return { type: "done" as const };
    },
  };
}

function makeState(overrides: Partial<ReactorState> = {}): ReactorState {
  return {
    turns: [],
    activeForks: [],
    pendingOperations: [],
    activeGates: [],
    tokenUsage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    lastCycleUsage: null,
    lastCycleSource: null,
    sessionId: "test-session",
    ...overrides,
  };
}

function stateWithUsage(inputTokens: number): ReactorState {
  return makeState({
    lastCycleUsage: {
      input: inputTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    lastCycleSource: {
      sourceId: "test-source",
      provider: "test",
      model: TEST_MODEL,
    },
  });
}

function makeMessageEvent(): ReactorInboundEvent {
  return {
    type: "message.received",
    message: {
      ref: { uid: 1, mailbox: "INBOX" },
      headers: {
        from: "hub@workbench.example",
        to: ["agent@workbench.example"],
        date: new Date().toISOString(),
        messageId: "msg-1@test",
      },
      flags: [],
      content: "Hello",
      signatureStatus: "valid",
    },
  };
}

function textTurn(text: string): AssistantTurn {
  return {
    role: "assistant",
    model: TEST_MODEL,
    timestamp: Date.now(),
    content: [{ type: "text" as const, text }],
  };
}

function inferenceDoneEvent(turn: AssistantTurn): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { id: "test-source", provider: "test", model: TEST_MODEL },
  } as unknown as ReactorInboundEvent;
}

function toolDoneEvent(callId: string): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId, content: "", isError: false },
  } as unknown as ReactorInboundEvent;
}

describe("wrapDirectorWithCompaction", () => {
  const tools: ToolDefinition[] = [];
  const systemPrompt = "You are a test agent.";

  it("null lastCycleUsage emits no compact", async () => {
    const director = wrapDirectorWithCompaction(
      createDefaultDirector(systemPrompt, tools),
      { windowFor },
    );
    const cap = makeCapabilities();

    const actions = await runDecide(
      director,
      makeMessageEvent(),
      makeState(),
      cap,
    );
    expect(actions.some((a) => a.type === "compact")).toBe(false);
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  it("below-threshold usage emits no compact", async () => {
    const director = wrapDirectorWithCompaction(
      createDefaultDirector(systemPrompt, tools),
      { windowFor },
    );
    const cap = makeCapabilities();
    const belowThreshold = TEST_WINDOW * (COMPACTION_TRIGGER_THRESHOLD - 0.1);

    const actions = await runDecide(
      director,
      makeMessageEvent(),
      stateWithUsage(belowThreshold),
      cap,
    );
    expect(actions.some((a) => a.type === "compact")).toBe(false);
    expect(actions.some((a) => a.type === "infer")).toBe(true);
  });

  it("usage past 80% with an upcoming infer emits exactly one compact immediately before the infer", async () => {
    const director = wrapDirectorWithCompaction(
      createDefaultDirector(systemPrompt, tools),
      { windowFor },
    );
    const cap = makeCapabilities();
    const overThreshold = TEST_WINDOW * (COMPACTION_TRIGGER_THRESHOLD + 0.05);

    // tool.done -> [checkpoint, infer] from the default director; drive a
    // real cycle through it so the actions array is real, not hand-rolled.
    const actions = await runDecide(
      director,
      toolDoneEvent("call-0"),
      stateWithUsage(overThreshold),
      cap,
    );

    const compactActions = actions.filter((a) => a.type === "compact");
    expect(compactActions).toHaveLength(1);
    expect(compactActions[0]).toMatchObject({
      type: "compact",
      compactor: SUMMARIZE_COMPACTOR_NAME,
    });

    const compactIndex = actions.findIndex((a) => a.type === "compact");
    const inferIndex = actions.findIndex((a) => a.type === "infer");
    expect(inferIndex).toBeGreaterThan(-1);
    expect(compactIndex).toBe(inferIndex - 1);
  });

  it("the latch suppresses a repeat compact on the immediately-following cycle while usage still reads high", async () => {
    const director = wrapDirectorWithCompaction(
      createDefaultDirector(systemPrompt, tools),
      { windowFor },
    );
    const cap = makeCapabilities();
    const overThreshold = TEST_WINDOW * (COMPACTION_TRIGGER_THRESHOLD + 0.05);

    const first = await runDecide(
      director,
      toolDoneEvent("call-0"),
      stateWithUsage(overThreshold),
      cap,
    );
    expect(first.some((a) => a.type === "compact")).toBe(true);

    // Same stale usage reading persists into the next cycle (compaction
    // hasn't produced a fresh reading yet) — the latch must suppress.
    const second = await runDecide(
      director,
      toolDoneEvent("call-1"),
      stateWithUsage(overThreshold),
      cap,
    );
    expect(second.some((a) => a.type === "compact")).toBe(false);
    expect(second.some((a) => a.type === "infer")).toBe(true);
  });

  it("once usage drops below threshold the latch resets and a later breach compacts again", async () => {
    const director = wrapDirectorWithCompaction(
      createDefaultDirector(systemPrompt, tools),
      { windowFor },
    );
    const cap = makeCapabilities();
    const overThreshold = TEST_WINDOW * (COMPACTION_TRIGGER_THRESHOLD + 0.05);
    const belowThreshold = TEST_WINDOW * (COMPACTION_TRIGGER_THRESHOLD - 0.1);

    const first = await runDecide(
      director,
      toolDoneEvent("call-0"),
      stateWithUsage(overThreshold),
      cap,
    );
    expect(first.some((a) => a.type === "compact")).toBe(true);

    // A fresh, smaller reading (the compaction took effect) resets the latch.
    const reset = await runDecide(
      director,
      toolDoneEvent("call-1"),
      stateWithUsage(belowThreshold),
      cap,
    );
    expect(reset.some((a) => a.type === "compact")).toBe(false);

    // Usage grows past the threshold again — must fire again.
    const second = await runDecide(
      director,
      toolDoneEvent("call-2"),
      stateWithUsage(overThreshold),
      cap,
    );
    expect(second.some((a) => a.type === "compact")).toBe(true);
  });

  it("a compaction that fails to shrink the working set re-fires on a later cycle instead of wedging forever", async () => {
    const director = wrapDirectorWithCompaction(
      createDefaultDirector(systemPrompt, tools),
      { windowFor },
    );
    const cap = makeCapabilities();
    const overThreshold = TEST_WINDOW * (COMPACTION_TRIGGER_THRESHOLD + 0.05);

    const first = await runDecide(
      director,
      toolDoneEvent("call-0"),
      stateWithUsage(overThreshold),
      cap,
    );
    expect(first.some((a) => a.type === "compact")).toBe(true);

    // The compaction did not shrink the working set — usage stays over
    // threshold. This cycle absorbs the one stale reading (the grace
    // cycle) and must not compact.
    const second = await runDecide(
      director,
      toolDoneEvent("call-1"),
      stateWithUsage(overThreshold),
      cap,
    );
    expect(second.some((a) => a.type === "compact")).toBe(false);

    // Usage is still over threshold on a third cycle — since the grace
    // cycle cleared the latch, compaction must retry rather than staying
    // permanently disabled.
    const third = await runDecide(
      director,
      toolDoneEvent("call-2"),
      stateWithUsage(overThreshold),
      cap,
    );
    expect(third.some((a) => a.type === "compact")).toBe(true);
  });

  it("a cycle with no infer (reply/done) emits no compact even above threshold", async () => {
    const director = wrapDirectorWithCompaction(
      createDefaultDirector(systemPrompt, tools),
      { windowFor },
    );
    const cap = makeCapabilities();
    const overThreshold = TEST_WINDOW * (COMPACTION_TRIGGER_THRESHOLD + 0.05);

    // inference.done with no tool calls and text content -> default director
    // replies; no infer action, so no compact should be inserted.
    const actions = await runDecide(
      director,
      inferenceDoneEvent(textTurn("final answer")),
      stateWithUsage(overThreshold),
      cap,
    );

    expect(actions.some((a) => a.type === "compact")).toBe(false);
    expect(actions.some((a) => a.type === "infer")).toBe(false);
    expect(actions.some((a) => a.type === "reply")).toBe(true);
  });

  it("emits fire / grace-skip telemetry under a sustained over-threshold breach", async () => {
    const events: { type: string; consecutiveGraceSkips?: number }[] = [];
    const director = wrapDirectorWithCompaction(
      createDefaultDirector(systemPrompt, tools),
      {
        windowFor,
        onEvent: (e) => {
          events.push(e);
        },
      },
    );
    const cap = makeCapabilities();
    const overThreshold = TEST_WINDOW * (COMPACTION_TRIGGER_THRESHOLD + 0.05);

    await runDecide(
      director,
      toolDoneEvent("call-0"),
      stateWithUsage(overThreshold),
      cap,
    );
    await runDecide(
      director,
      toolDoneEvent("call-1"),
      stateWithUsage(overThreshold),
      cap,
    );
    await runDecide(
      director,
      toolDoneEvent("call-2"),
      stateWithUsage(overThreshold),
      cap,
    );
    await runDecide(
      director,
      toolDoneEvent("call-3"),
      stateWithUsage(overThreshold),
      cap,
    );

    expect(events.map((e) => e.type)).toEqual([
      "fire",
      "grace-skip",
      "fire",
      "grace-skip",
    ]);
    expect(events[1]).toMatchObject({
      type: "grace-skip",
      consecutiveGraceSkips: 1,
    });
    expect(events[3]).toMatchObject({
      type: "grace-skip",
      consecutiveGraceSkips: 2,
    });
  });

  it("emits reset telemetry when usage drops below threshold after a latch", async () => {
    const events: { type: string }[] = [];
    const director = wrapDirectorWithCompaction(
      createDefaultDirector(systemPrompt, tools),
      {
        windowFor,
        onEvent: (e) => {
          events.push(e);
        },
      },
    );
    const cap = makeCapabilities();
    const overThreshold = TEST_WINDOW * (COMPACTION_TRIGGER_THRESHOLD + 0.05);
    const belowThreshold = TEST_WINDOW * (COMPACTION_TRIGGER_THRESHOLD - 0.1);

    await runDecide(
      director,
      toolDoneEvent("call-0"),
      stateWithUsage(overThreshold),
      cap,
    );
    await runDecide(
      director,
      toolDoneEvent("call-1"),
      stateWithUsage(belowThreshold),
      cap,
    );

    expect(events.map((e) => e.type)).toEqual(["fire", "reset"]);
  });
});
