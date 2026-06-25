import { describe, expect, it, mock } from "bun:test";
import type {
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
  ToolDefinition,
} from "@intx/types/runtime";
import { createPersonalAgentDirector } from "./director";

function makeCapabilities(): ReactorCapabilities & {
  replyArg: string | undefined;
  waitCalled: boolean;
} {
  const cap = {
    replyArg: undefined as string | undefined,
    waitCalled: false,
    infer: mock(() => ({ type: "infer" as const })),
    executeTools: mock(() => ({ type: "execute_tools" as const, calls: [] })),
    suspend: mock(() => ({
      type: "suspend" as const,
      gate: { type: "approval" as const, gateId: "", timeoutMs: 0 },
    })),
    fork: mock(() => ({
      type: "fork" as const,
      mode: "independent" as const,
      forkId: "",
    })),
    emit: mock(() => ({
      type: "emit" as const,
      eventType: "custom.x" as const,
      data: {},
    })),
    reply(content: string) {
      cap.replyArg = content;
      return { type: "reply" as const, content };
    },
    checkpoint: mock(() => ({ type: "checkpoint" as const, message: "" })),
    compact: mock(() => ({
      type: "compact" as const,
      compactor: "",
      reason: "",
    })),
    wait() {
      cap.waitCalled = true;
      return { type: "wait" as const };
    },
    done: mock(() => ({ type: "done" as const })),
  };
  return cap;
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

function makeMessageEvent(from: string): ReactorInboundEvent {
  return {
    type: "message.received",
    message: {
      ref: { uid: 1, mailbox: "INBOX" },
      headers: {
        from,
        to: ["myra@workbench.example"],
        date: new Date().toISOString(),
        messageId: "msg-1@test",
      },
      flags: [],
      content: "Hello Myra",
      signatureStatus: "valid",
    },
  };
}

describe("createPersonalAgentDirector", () => {
  const tools: ToolDefinition[] = [];
  const systemPrompt = "You are Myra.";
  const allowedSenders = ["alice@example.com", "bob@example.com"];

  it("allows messages from allowed senders and delegates to base director", async () => {
    const director = createPersonalAgentDirector(
      systemPrompt,
      tools,
      allowedSenders,
    );
    const cap = makeCapabilities();
    const event = makeMessageEvent("alice@example.com");

    const actions = await director.decide(event, makeState(), cap);
    const arr = Array.isArray(actions) ? actions : [actions];

    // Base director responds to message.received with infer
    expect(arr.some((a) => a.type === "infer")).toBe(true);
  });

  it("rejects messages from unknown senders", async () => {
    const director = createPersonalAgentDirector(
      systemPrompt,
      tools,
      allowedSenders,
    );
    const cap = makeCapabilities();
    const event = makeMessageEvent("unknown@evil.com");

    const actions = await director.decide(event, makeState(), cap);
    const arr = Array.isArray(actions) ? actions : [actions];

    expect(arr.some((a) => a.type === "reply")).toBe(true);
    expect(arr.some((a) => a.type === "wait")).toBe(true);
    expect(cap.replyArg).toBe("Not authorised");
  });

  it("does not call infer when sender is rejected", async () => {
    const director = createPersonalAgentDirector(
      systemPrompt,
      tools,
      allowedSenders,
    );
    const cap = makeCapabilities();
    const event = makeMessageEvent("spam@bad.example");

    const actions = await director.decide(event, makeState(), cap);
    const arr = Array.isArray(actions) ? actions : [actions];

    expect(arr.some((a) => a.type === "infer")).toBe(false);
  });

  it("allows all senders when allowedSenders is empty (open policy)", async () => {
    const director = createPersonalAgentDirector(systemPrompt, tools, []);
    const cap = makeCapabilities();
    const event = makeMessageEvent("anyone@anywhere.com");

    const actions = await director.decide(event, makeState(), cap);
    const arr = Array.isArray(actions) ? actions : [actions];

    // Empty allowedSenders = no filtering
    expect(arr.some((a) => a.type === "infer")).toBe(true);
  });
});
