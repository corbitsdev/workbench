import { describe, expect, it } from "bun:test";
import type {
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
  AssistantTurn,
  ToolCall,
  InferenceOptions,
} from "@intx/types/runtime";
import {
  createInvokeBudgetDirector,
  INVOKE_MAX_TOOL_CALLS,
  INVOKE_BUDGET_STOP_MARKER,
} from "./invoke-budget-director";
import { TRIAGE_MAX_TOOL_CALLS } from "./triage-budget-director";

function makeCapabilities(): ReactorCapabilities {
  return {
    infer(options?: InferenceOptions) {
      return {
        type: "infer" as const,
        ...(options !== undefined ? { options } : {}),
      };
    },
    executeTools(calls: ToolCall[]) {
      return { type: "execute_tools" as const, calls };
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
    checkpoint() {
      return { type: "checkpoint" as const, message: "checkpoint" };
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

function makeState(): ReactorState {
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

function makeMessageEvent(): ReactorInboundEvent {
  return {
    type: "message.received",
    message: {
      ref: { uid: 1, mailbox: "INBOX" },
      headers: {
        from: "ins_caller@workbench.example",
        to: ["ins_sub@workbench.example"],
        date: new Date().toISOString(),
        messageId: "brief-2@test",
      },
      flags: [],
      content: "A brand new brief.",
      signatureStatus: "valid",
    },
  };
}

function stateWithTokens(input: number): ReactorState {
  return { ...makeState(), tokenUsage: { ...makeState().tokenUsage, input } };
}

function inferenceDoneEvent(turn: AssistantTurn): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { id: "test-source", provider: "test", model: "test" },
  } as unknown as ReactorInboundEvent;
}

describe("createInvokeBudgetDirector", () => {
  const systemPrompt = "You are Lincoln, invoked.";

  it("uses the invoke cap, not the triage cap: a batch over triage's cap but under invoke's still executes", async () => {
    expect(INVOKE_MAX_TOOL_CALLS).toBeGreaterThan(TRIAGE_MAX_TOOL_CALLS);
    const director = createInvokeBudgetDirector(systemPrompt, []);
    const cap = makeCapabilities();

    const actions = await director.decide(
      inferenceDoneEvent(toolCallTurn(TRIAGE_MAX_TOOL_CALLS + 1)),
      makeState(),
      cap,
    );
    const arr = Array.isArray(actions) ? actions : [actions];
    const exec = arr.find((a) => a.type === "execute_tools");
    expect(exec).toBeDefined();
    if (exec?.type === "execute_tools") {
      expect(exec.calls).toHaveLength(TRIAGE_MAX_TOOL_CALLS + 1);
    }
  });

  it("once the invoke tool-call cap is reached, the next composition steers to conclude with the invoke stop marker", async () => {
    const director = createInvokeBudgetDirector(systemPrompt, []);
    const cap = makeCapabilities();

    await director.decide(
      inferenceDoneEvent(toolCallTurn(INVOKE_MAX_TOOL_CALLS)),
      makeState(),
      cap,
    );

    const actions = await director.decide(
      inferenceDoneEvent(textTurn("still working")),
      makeState(),
      cap,
    );
    const arr = Array.isArray(actions) ? actions : [actions];
    const reply = arr.find((a) => a.type === "reply");
    expect(reply).toBeDefined();
    if (reply?.type === "reply") {
      expect(reply.content).toContain(INVOKE_BUDGET_STOP_MARKER);
    }
  });

  it("resets the budget on a new brief, so a reused live session is not permanently capped", async () => {
    const director = createInvokeBudgetDirector(systemPrompt, []);
    const cap = makeCapabilities();

    // Brief 1 exhausts the tool-call cap; the honest handoff fires.
    await director.decide(
      inferenceDoneEvent(toolCallTurn(INVOKE_MAX_TOOL_CALLS)),
      makeState(),
      cap,
    );
    const cappedActions = await director.decide(
      inferenceDoneEvent(textTurn("out of budget")),
      makeState(),
      cap,
    );
    const cappedArr = Array.isArray(cappedActions)
      ? cappedActions
      : [cappedActions];
    const cappedReply = cappedArr.find((a) => a.type === "reply");
    if (cappedReply?.type === "reply") {
      expect(cappedReply.content).toContain(INVOKE_BUDGET_STOP_MARKER);
    }

    // Brief 2 arrives at the same session: budget must be fresh.
    await director.decide(makeMessageEvent(), makeState(), cap);

    const toolActions = await director.decide(
      inferenceDoneEvent(toolCallTurn(2)),
      makeState(),
      cap,
    );
    const toolArr = Array.isArray(toolActions) ? toolActions : [toolActions];
    const exec = toolArr.find((a) => a.type === "execute_tools");
    expect(exec).toBeDefined();

    const replyActions = await director.decide(
      inferenceDoneEvent(textTurn("all done")),
      makeState(),
      cap,
    );
    const replyArr = Array.isArray(replyActions)
      ? replyActions
      : [replyActions];
    const reply = replyArr.find((a) => a.type === "reply");
    expect(reply).toBeDefined();
    if (reply?.type === "reply") {
      expect(reply.content).not.toContain(INVOKE_BUDGET_STOP_MARKER);
    }
  });

  it("token caps are per-brief: cumulative session tokens from earlier briefs do not cap a new brief", async () => {
    const director = createInvokeBudgetDirector(systemPrompt, []);
    const cap = makeCapabilities();
    const highTokens = stateWithTokens(1_500_001);

    // A new brief arrives on a session whose CUMULATIVE input tokens already
    // exceed the per-brief ceiling; the reset rebases the token baseline.
    await director.decide(makeMessageEvent(), highTokens, cap);

    const actions = await director.decide(
      inferenceDoneEvent(toolCallTurn(1)),
      highTokens,
      cap,
    );
    const arr = Array.isArray(actions) ? actions : [actions];
    expect(arr.find((a) => a.type === "execute_tools")).toBeDefined();
  });
});
