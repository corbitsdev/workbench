// Workbench director: empty-turn retry + honest reply, composed over
// DefaultDirector so tool.done (including errors) still re-infers.
import { expect, test } from "bun:test";

import { defaultDirectorFactory } from "@intx/agent";
import { createCapabilities, createDefaultDirector } from "@intx/inference";
import type {
  AssistantTurn,
  ReactorAction,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ToolResult,
} from "@intx/types/runtime";

import {
  EMPTY_TURN_REPLY,
  WORKBENCH_DIRECTOR_ID,
  createWorkbenchDirector,
  createWorkbenchDirectorRegistry,
  workbenchDirectorFactory,
} from "./workbench-director";

const caps = createCapabilities();

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

const source = { sourceId: "src_1", provider: "test", model: "test" };

function state(): ReactorState {
  return {
    turns: [],
    activeForks: [],
    pendingOperations: [],
    activeGates: [],
    tokenUsage: usage,
    lastCycleUsage: usage,
    lastCycleSource: source,
    sessionId: "sess_1",
  };
}

function emptyTurn(): AssistantTurn {
  return { role: "assistant", content: [], model: "test", timestamp: 0 };
}

function textTurn(text: string): AssistantTurn {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "test",
    timestamp: 0,
  };
}

function toolTurn(name: string): AssistantTurn {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id: "call_1", name, arguments: {} }],
    model: "test",
    timestamp: 0,
  };
}

function inferenceDone(turn: AssistantTurn): ReactorInboundEvent {
  return { type: "inference.done", turn, usage, source };
}

function asList(action: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(action) ? action : [action];
}

function typesOf(action: ReactorAction | ReactorAction[]): string[] {
  return asList(action).map((a) => a.type);
}

function replyOf(action: ReactorAction | ReactorAction[]): string | undefined {
  return asList(action).find((a) => a.type === "reply")?.content;
}

async function seedToolBatch(director: ReactorDirector): Promise<void> {
  await director.decide(inferenceDone(toolTurn("look_up")), state(), caps);
}

test("empty inference.done retries infer once", async () => {
  const director = createWorkbenchDirector("you are a test agent");
  const actions = await director.decide(
    inferenceDone(emptyTurn()),
    state(),
    caps,
  );

  expect(typesOf(actions)).toEqual(["checkpoint", "infer"]);
});

test("a second empty inference.done replies honestly instead of waiting", async () => {
  const director = createWorkbenchDirector("you are a test agent");
  await director.decide(inferenceDone(emptyTurn()), state(), caps);
  const actions = await director.decide(
    inferenceDone(emptyTurn()),
    state(),
    caps,
  );

  expect(typesOf(actions)).toEqual(["checkpoint", "reply"]);
  expect(replyOf(actions)).toBe(EMPTY_TURN_REPLY);
  expect(replyOf(actions)).toContain("empty model turn");
});

test("empty then a real text turn replies with the model text", async () => {
  const director = createWorkbenchDirector("you are a test agent");
  await director.decide(inferenceDone(emptyTurn()), state(), caps);
  const actions = await director.decide(
    inferenceDone(textTurn("here is the answer")),
    state(),
    caps,
  );

  expect(typesOf(actions)).toEqual(["checkpoint", "reply"]);
  expect(replyOf(actions)).toBe("here is the answer");
});

test("a text turn on the first inference.done replies without retrying", async () => {
  const director = createWorkbenchDirector("you are a test agent");
  const actions = await director.decide(
    inferenceDone(textTurn("hello")),
    state(),
    caps,
  );

  expect(typesOf(actions)).toEqual(["checkpoint", "reply"]);
  expect(replyOf(actions)).toBe("hello");
});

test("tool calls still execute; DefaultDirector already re-infers on errored tool.done", async () => {
  const vendor = createDefaultDirector("you are a test agent");
  const workbench = createWorkbenchDirector("you are a test agent");
  await seedToolBatch(vendor);
  await seedToolBatch(workbench);

  const errored: ToolResult = {
    callId: "call_1",
    content: "look_up failed",
    isError: true,
  };
  const event: ReactorInboundEvent = { type: "tool.done", result: errored };

  const vendorActions = await vendor.decide(event, state(), caps);
  const workbenchActions = await workbench.decide(event, state(), caps);

  expect(typesOf(vendorActions)).toEqual(["checkpoint", "infer"]);
  expect(typesOf(workbenchActions)).toEqual(["checkpoint", "infer"]);
});

test("reactive mode still waits on an empty turn (no retry)", async () => {
  const director = createWorkbenchDirector("you are a test agent", [], {
    mode: "reactive",
  });
  const actions = await director.decide(
    inferenceDone(emptyTurn()),
    state(),
    caps,
  );

  expect(typesOf(actions)).toEqual(["checkpoint", "wait"]);
});

test("a new message.received resets the empty-turn retry budget", async () => {
  const director = createWorkbenchDirector("you are a test agent");
  await director.decide(inferenceDone(emptyTurn()), state(), caps);
  await director.decide(
    {
      type: "message.received",
      message: { id: "m1", content: "hi" } as never,
    },
    state(),
    caps,
  );
  const actions = await director.decide(
    inferenceDone(emptyTurn()),
    state(),
    caps,
  );

  expect(typesOf(actions)).toEqual(["checkpoint", "infer"]);
});

test("the factory is namespaced and is the sidecar registry default", () => {
  expect(workbenchDirectorFactory.id).toBe(WORKBENCH_DIRECTOR_ID);
  const registry = createWorkbenchDirectorRegistry();
  expect(registry.defaultFactory().id).toBe(WORKBENCH_DIRECTOR_ID);
  expect(
    registry.resolve({ id: defaultDirectorFactory.id, config: {} }).id,
  ).toBe(defaultDirectorFactory.id);
});
