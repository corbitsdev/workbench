import { describe, expect, it } from "bun:test";
import type {
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
  ToolDefinition,
  ToolCall,
  AssistantTurn,
  InferenceOptions,
} from "@intx/types/runtime";
import {
  createTriageBudgetDirector,
  TRIAGE_MAX_TOOL_CALLS,
  TRIAGE_BUDGET_STOP_MARKER,
} from "./triage-budget-director";

// Mirrors the real `createCapabilities` from @intx/inference: the infer
// action carries whatever options it is given, so the wrapper's tools/
// systemPrompt overrides are observable on the returned action.
function makeCapabilities(): ReactorCapabilities {
  return {
    infer(options?: InferenceOptions) {
      return {
        type: "infer" as const,
        ...(options !== undefined ? { options } : {}),
      };
    },
    executeTools(calls: ToolCall[], parallel?: boolean, addToHistory?: boolean) {
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

function makeMessageEvent(): ReactorInboundEvent {
  return {
    type: "message.received",
    message: {
      ref: { uid: 1, mailbox: "INBOX" },
      headers: {
        from: "hub@workbench.example",
        to: ["triage@workbench.example"],
        date: new Date().toISOString(),
        messageId: "msg-1@test",
      },
      flags: [],
      content: "Triage this inbound message.",
      signatureStatus: "valid",
    },
  };
}

function toolCallTurn(count: number): AssistantTurn {
  return {
    role: "assistant",
    model: "test-model",
    timestamp: Date.now(),
    content: Array.from({ length: count }, (_, i) => ({
      type: "tool_call" as const,
      id: `call-${i}`,
      name: "search_tools",
      arguments: {},
    })),
  };
}

function textTurn(text: string): AssistantTurn {
  return {
    role: "assistant",
    model: "test-model",
    timestamp: Date.now(),
    content: [{ type: "text" as const, text }],
  };
}

function inferenceDoneEvent(turn: AssistantTurn): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { id: "test-source", provider: "test", model: "test" },
  } as unknown as ReactorInboundEvent;
}

describe("createTriageBudgetDirector", () => {
  const tools: ToolDefinition[] = [];
  const systemPrompt = "You are Myra, triaging.";

  it("below the cap, delegates to the default director unchanged", async () => {
    const director = createTriageBudgetDirector(systemPrompt, tools);
    const cap = makeCapabilities();

    const actions = await director.decide(
      makeMessageEvent(),
      makeState(),
      cap,
    );
    const arr = Array.isArray(actions) ? actions : [actions];

    const infer = arr.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    if (infer?.type === "infer") {
      expect(infer.options?.tools).toEqual(tools);
      expect(infer.options?.systemPrompt).toBe(systemPrompt);
    }
  });

  it("executes tool calls that reach exactly the cap in one batch", async () => {
    const director = createTriageBudgetDirector(systemPrompt, tools);
    const cap = makeCapabilities();

    const actions = await director.decide(
      inferenceDoneEvent(toolCallTurn(TRIAGE_MAX_TOOL_CALLS)),
      makeState(),
      cap,
    );
    const arr = Array.isArray(actions) ? actions : [actions];

    const exec = arr.find((a) => a.type === "execute_tools");
    expect(exec).toBeDefined();
    if (exec?.type === "execute_tools") {
      expect(exec.calls).toHaveLength(TRIAGE_MAX_TOOL_CALLS);
    }
  });

  it("once the tool-call cap is reached, the next composition offers no tools and steers conclusion", async () => {
    const director = createTriageBudgetDirector(systemPrompt, tools);
    const cap = makeCapabilities();

    // First batch reaches the cap exactly.
    await director.decide(
      inferenceDoneEvent(toolCallTurn(TRIAGE_MAX_TOOL_CALLS)),
      makeState(),
      cap,
    );

    // Next inference.done — model tries to keep going with more tool calls,
    // but composition must now offer none and steer to conclude.
    const actions = await director.decide(
      inferenceDoneEvent(textTurn("still working")),
      makeState(),
      cap,
    );
    const arr = Array.isArray(actions) ? actions : [actions];

    // No tool calls, so default director's fallback path replies directly —
    // verify the reply carries the honest stop marker.
    const reply = arr.find((a) => a.type === "reply");
    expect(reply).toBeDefined();
    if (reply?.type === "reply") {
      expect(reply.content).toContain(TRIAGE_BUDGET_STOP_MARKER);
    }
  });

  it("steers a still-tool-calling turn to conclude once over the tool-call cap", async () => {
    const director = createTriageBudgetDirector(systemPrompt, tools);
    const cap = makeCapabilities();

    await director.decide(
      inferenceDoneEvent(toolCallTurn(TRIAGE_MAX_TOOL_CALLS)),
      makeState(),
      cap,
    );

    // Simulate every outstanding tool.done firing; only the last one flips
    // the base director's pending-results counter to zero and re-infers.
    const toolDoneEvent: ReactorInboundEvent = {
      type: "tool.done",
      result: { callId: "call-0", content: "", isError: false },
    } as unknown as ReactorInboundEvent;

    let actions: Awaited<ReturnType<typeof director.decide>> = [];
    for (let i = 0; i < TRIAGE_MAX_TOOL_CALLS; i++) {
      actions = await director.decide(toolDoneEvent, makeState(), cap);
    }
    const arr = Array.isArray(actions) ? actions : [actions];

    const infer = arr.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    if (infer?.type === "infer") {
      expect(infer.options?.tools).toEqual([]);
      expect(infer.options?.systemPrompt).toContain(TRIAGE_BUDGET_STOP_MARKER);
    }
  });

  it("token cap breach steers conclusion even with zero tool calls", async () => {
    const director = createTriageBudgetDirector(systemPrompt, tools);
    const cap = makeCapabilities();

    const overBudgetState = makeState({
      tokenUsage: {
        input: 1_000_001,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
    });

    const actions = await director.decide(
      inferenceDoneEvent(textTurn("partial answer")),
      overBudgetState,
      cap,
    );
    const arr = Array.isArray(actions) ? actions : [actions];

    const reply = arr.find((a) => a.type === "reply");
    expect(reply).toBeDefined();
    if (reply?.type === "reply") {
      expect(reply.content).toContain(TRIAGE_BUDGET_STOP_MARKER);
    }
  });

  it("does not duplicate the stop marker if already present", async () => {
    const director = createTriageBudgetDirector(systemPrompt, tools);
    const cap = makeCapabilities();

    await director.decide(
      inferenceDoneEvent(toolCallTurn(TRIAGE_MAX_TOOL_CALLS)),
      makeState(),
      cap,
    );

    const actions = await director.decide(
      inferenceDoneEvent(textTurn(`done. ${TRIAGE_BUDGET_STOP_MARKER}`)),
      makeState(),
      cap,
    );
    const arr = Array.isArray(actions) ? actions : [actions];
    const reply = arr.find((a) => a.type === "reply");
    if (reply?.type === "reply") {
      const occurrences = reply.content.split(TRIAGE_BUDGET_STOP_MARKER).length - 1;
      expect(occurrences).toBe(1);
    }
  });
});
