// Regression coverage for the `message_response` gate mechanism CL-7190
// introduces: a `BeforeToolExtension` returning `suspend` must park a tool
// call structurally — no `tool.done`, no re-inference — until a correlated
// inbound message resolves it, at which point exactly one re-inference
// follows. This is the reactor's own dispatch loop, driven for real (not a
// mocked decision shape), because the bug this guards against
// (CL-7190/CL-7191) lives in that loop: a mocked reactor passes on the
// broken code just as easily as the fixed one.
import { expect, test } from "bun:test";
import type {
  BeforeToolExtension,
  ReactorCapabilities,
  ReactorDirector,
  ToolCall,
} from "@intx/types/runtime";

import { createReactor } from "./reactor";
import type { ReactorEmittedEvent } from "./reactor";
import {
  assistantTurnWithToolCall,
  buildInboundMessage,
  createFakeInferenceSource,
  createInMemoryContextStore,
  createRecordingToolRunner,
  createScriptedInferenceRunner,
  createUnusedDependencies,
} from "./testing/fakes";

/**
 * A director simple enough to have no opinions of its own: infer on a
 * fresh message or a correlated answer landing in history, and turn an
 * assistant turn's `tool_call` blocks into `execute_tools`. Everything
 * else waits. This is deliberately NOT `WorkbenchDirector` or
 * `DefaultDirector` — the point of this test is that the suspend/resume
 * mechanism itself (owned by the reactor, `@intx/agent`, and whichever
 * `BeforeToolExtension` a tool package contributes) needs no director
 * cooperation to behave correctly; CL-7190's own bug lived in a director
 * that mishandled this, but the fix does not depend on director logic.
 */
function createMinimalDirector(): ReactorDirector {
  return {
    decide(event, _state, capabilities: ReactorCapabilities) {
      switch (event.type) {
        case "message.received":
          return Promise.resolve(capabilities.infer());
        case "inference.done": {
          const calls: ToolCall[] = event.turn.content
            .filter(
              (block): block is Extract<typeof block, { type: "tool_call" }> =>
                block.type === "tool_call",
            )
            .map((block) => ({
              id: block.id,
              name: block.name,
              arguments: block.arguments,
            }));
          if (calls.length > 0) {
            return Promise.resolve(capabilities.executeTools(calls, false));
          }
          // No tool call named: an ordinary reply completed. `wait()`
          // returns the reactor to idle for this message — `done()` would
          // shut the whole reactor down, which a routine reply must not do.
          return Promise.resolve(capabilities.wait());
        }
        case "resume.tool_result":
          return Promise.resolve(capabilities.infer());
        case "resume.execute_tools":
          return Promise.resolve(capabilities.executeTools(event.calls));
        default:
          return Promise.resolve(capabilities.wait());
      }
    },
  };
}

/** Always suspends whatever call it's given on a `message_response` gate
 * keyed by the call's own id — mirrors `@corbits/interaction-tools`'
 * `beforeAskUser`, generically, with no name-based special-casing. */
function alwaysSuspendExtension(): BeforeToolExtension {
  return {
    beforeTool: (call) => {
      const timeoutAt = Date.now() + 60_000;
      return Promise.resolve({
        type: "suspend",
        gate: {
          type: "message_response",
          gateId: `pending-${call.id}`,
          correlationId: call.id,
          timeoutAt,
        },
        pendingOp: {
          correlationId: call.id,
          kind: "message_response",
          registeredAt: Date.now(),
          gateId: `pending-${call.id}`,
          timeoutAt,
          suspendedCall: call,
        },
      });
    },
  };
}

function collectEvents() {
  const events: ReactorEmittedEvent[] = [];
  return { events, onEvent: (e: ReactorEmittedEvent) => events.push(e) };
}

test("a suspended tool call produces no tool.done and no re-inference", async () => {
  const call: ToolCall = { id: "call_1", name: "ask_user", arguments: {} };
  const { runner, callCount } = createScriptedInferenceRunner([
    assistantTurnWithToolCall(call),
  ]);
  const toolRunner = createRecordingToolRunner();
  const { events, onEvent } = collectEvents();

  const reactor = createReactor({
    sessionId: "session-1",
    director: createMinimalDirector(),
    source: createFakeInferenceSource(),
    toolRunner,
    contextStore: createInMemoryContextStore(),
    onEvent,
    deps: createUnusedDependencies(),
    inferenceRunner: runner,
    beforeToolExtensions: [alwaysSuspendExtension()],
  });

  reactor.start();
  reactor.deliver(buildInboundMessage({ content: "What should I do?" }));

  // Let the async start()/deliver() chain settle: load -> message.received
  // -> infer -> inference.done -> execute_tools -> suspend -> commit.
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(callCount()).toBe(1);
  expect(toolRunner.calls).toEqual([]);
  expect(events.some((e) => e.type === "tool.done")).toBe(false);

  const blocked = events.find((e) => e.type === "reactor.gate.blocked");
  expect(blocked).toBeDefined();
  expect(
    (blocked as Extract<ReactorEmittedEvent, { type: "reactor.gate.blocked" }>)
      .data.correlationId,
  ).toBe(call.id);
});

test("a correlated reply clears the gate and drives exactly one more infer", async () => {
  const call: ToolCall = { id: "call_2", name: "ask_user", arguments: {} };
  const { runner, callCount } = createScriptedInferenceRunner([
    assistantTurnWithToolCall(call),
    assistantTurnWithToolCall({ id: "call_2b", name: "noop", arguments: {} }),
  ]);
  const toolRunner = createRecordingToolRunner();
  const { events, onEvent } = collectEvents();

  const reactor = createReactor({
    sessionId: "session-2",
    director: createMinimalDirector(),
    source: createFakeInferenceSource(),
    toolRunner,
    contextStore: createInMemoryContextStore(),
    onEvent,
    deps: createUnusedDependencies(),
    inferenceRunner: runner,
    beforeToolExtensions: [alwaysSuspendExtension()],
  });

  reactor.start();
  reactor.deliver(buildInboundMessage({ content: "What should I do?" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(callCount()).toBe(1);

  reactor.deliver(
    buildInboundMessage({ content: "Staging", correlationId: call.id }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(callCount()).toBe(2);
  // The correlated reply resolves the parked call directly — it never
  // becomes an ordinary `message.received` the director would infer twice
  // over, and it never reaches `toolRunner.run` (there is nothing left to
  // execute once the user has answered).
  expect(events.filter((e) => e.type === "message.received").length).toBe(1);
  expect(toolRunner.calls).toEqual([]);
  expect(events.some((e) => e.type === "message.correlated")).toBe(true);
});

test("two concurrent questions answered out of order each resolve their own gate", async () => {
  const callA: ToolCall = { id: "call_a", name: "ask_user", arguments: {} };
  const callB: ToolCall = { id: "call_b", name: "ask_user", arguments: {} };
  // Three inference cycles: the first two each surface one of the two
  // ask_user calls (as if two questions were asked back to back before
  // either was answered); the reactor parks each on its own gate keyed by
  // its own call id, so no scripted turn is needed for a re-infer beyond
  // this test's two correlated replies driving `resume.tool_result`
  // directly rather than a fresh `inference.done`.
  const plainReply = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    model: "fake-model",
    timestamp: Date.now(),
  });
  const { runner, callCount } = createScriptedInferenceRunner([
    assistantTurnWithToolCall(callA),
    assistantTurnWithToolCall(callB),
    // Each correlated answer below drives one more re-infer
    // (`resume.tool_result` -> `capabilities.infer()`); neither reply names
    // a further tool call, so the director's `inference.done` branch calls
    // `capabilities.done()` and the run settles.
    plainReply("got B's answer"),
    plainReply("got A's answer"),
  ]);
  const toolRunner = createRecordingToolRunner();
  const { events, onEvent } = collectEvents();

  const reactor = createReactor({
    sessionId: "session-3",
    director: createMinimalDirector(),
    source: createFakeInferenceSource(),
    toolRunner,
    contextStore: createInMemoryContextStore(),
    onEvent,
    deps: createUnusedDependencies(),
    inferenceRunner: runner,
    beforeToolExtensions: [alwaysSuspendExtension()],
  });

  reactor.start();
  reactor.deliver(buildInboundMessage({ content: "Question A?" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  reactor.deliver(buildInboundMessage({ content: "Question B?" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(callCount()).toBe(2);

  // Answer B first, then A — reverse of arrival order. Cross-wired
  // correlation would hand B's answer to A's parked call (or vice versa);
  // asserting the resume.tool_result event body proves each answer lands
  // on its own call id.
  reactor.deliver(
    buildInboundMessage({ content: "Answer to B", correlationId: callB.id }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  reactor.deliver(
    buildInboundMessage({ content: "Answer to A", correlationId: callA.id }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(callCount()).toBe(4);

  const correlated = events.filter((e) => e.type === "message.correlated") as Extract<
    ReactorEmittedEvent,
    { type: "message.correlated" }
  >[];
  expect(correlated).toHaveLength(2);
  expect(correlated[0]?.data.correlationId).toBe(callB.id);
  expect(correlated[0]?.data.message.content).toBe("Answer to B");
  expect(correlated[1]?.data.correlationId).toBe(callA.id);
  expect(correlated[1]?.data.message.content).toBe("Answer to A");
});
