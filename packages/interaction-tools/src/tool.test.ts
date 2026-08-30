import { expect, test } from "bun:test";
import type { ToolBundle } from "@intx/agent";
import type { ToolCall } from "@intx/types/runtime";

import { ASK_USER_TOOL, interactionTools } from "./tool";
import type { AskUserEnv } from "./tool";

function testEnv(): AskUserEnv {
  return {
    hubChatUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as AskUserEnv;
}

async function withFetch<T>(
  fetchImpl: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function beforeTool(bundle: ToolBundle, call: ToolCall) {
  const extension = bundle.beforeToolExtension;
  if (extension === undefined) {
    throw new Error(
      "interactionTools did not contribute a beforeToolExtension",
    );
  }
  return extension.beforeTool(call, {} as never, new AbortController().signal);
}

test("declares exactly ask_user, with no approval gate", () => {
  expect(interactionTools.definitions).toEqual([{ name: ASK_USER_TOOL }]);
});

test("requires the sanctioned env keys", () => {
  expect(interactionTools.requires).toEqual([
    "hubChatUrl",
    "sidecarToken",
    "address",
  ]);
});

test("ask_user posts a question block and suspends on a message_response gate", async () => {
  let posted = false;
  const fetchImpl = (async () => {
    posted = true;
    return new Response(
      JSON.stringify({ id: "msg_1", createdAt: "2026-08-17T00:00:00.000Z" }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const call = {
    id: "call_1",
    name: ASK_USER_TOOL,
    arguments: {
      question: "Which environment?",
      options: ["Staging", "Production"],
    },
  };
  const before = Date.now();
  const decision = await withFetch(fetchImpl, () => beforeTool(bundle, call));

  expect(posted).toBe(true);
  if (decision.type !== "suspend") {
    throw new Error(`expected a suspend decision, got ${decision.type}`);
  }
  expect(decision.gate.type).toBe("message_response");
  expect(decision.gate.timeoutAt).toBeGreaterThan(before);
  expect(decision.pendingOp.kind).toBe("message_response");
  expect(decision.pendingOp.suspendedCall).toEqual(call);
  expect(decision.pendingOp.correlationId).toBe(decision.gate.correlationId);
  // Minted by `postQuestion` (`q_<hex32>`), not a separately-minted
  // `crypto.randomUUID()` — the gate and the question card share one id.
  expect(decision.gate.correlationId).toMatch(/^q_[0-9a-f]{32}$/);
});

test("ask_user rejects fewer than 2 options before ever posting", async () => {
  let posted = false;
  const fetchImpl = (async () => {
    posted = true;
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const decision = await withFetch(fetchImpl, () =>
    beforeTool(bundle, {
      id: "call_1",
      name: ASK_USER_TOOL,
      arguments: { question: "Q?", options: ["only one"] },
    }),
  );

  expect(posted).toBe(false);
  expect(decision.type).toBe("block");
});

test("ask_user surfaces a no-own-channel failure as a blocked call, not a throw", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ error: { code: "not_found", message: "no channel" } }),
      { status: 404 },
    )) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const decision = await withFetch(fetchImpl, () =>
    beforeTool(bundle, {
      id: "call_1",
      name: ASK_USER_TOOL,
      arguments: { question: "Q?", options: ["a", "b"] },
    }),
  );

  if (decision.type !== "block") {
    throw new Error(`expected a block decision, got ${decision.type}`);
  }
  expect(decision.reason).toContain("no channel");
});

test("a call for another tool name is allowed through unsuspended", async () => {
  const bundle = interactionTools(testEnv());
  const decision = await beforeTool(bundle, {
    id: "call_1",
    name: "some_other_tool",
    arguments: {},
  });
  expect(decision).toEqual({ type: "allow" });
});

test("run() is never the ask_user path: reaching it fails loud", async () => {
  const bundle = interactionTools(testEnv());
  const result = await bundle.run(
    { id: "call_1", name: ASK_USER_TOOL, arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("beforeToolExtension");
});

test("an unknown tool name returns an honest error", async () => {
  const bundle = interactionTools(testEnv());
  const result = await bundle.run(
    { id: "call_1", name: "delete_everything", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/);
});
