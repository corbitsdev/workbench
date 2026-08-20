import { expect, test } from "bun:test";

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

test("ask_user posts a question block and returns immediately, never the answer", async () => {
  let posted = false;
  const fetchImpl = (async () => {
    posted = true;
    return new Response(
      JSON.stringify({ id: "msg_1", createdAt: "2026-08-17T00:00:00.000Z" }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const result = await withFetch(fetchImpl, () =>
    bundle.run(
      {
        id: "call_1",
        name: ASK_USER_TOOL,
        arguments: {
          question: "Which environment?",
          options: ["Staging", "Production"],
        },
      },
      new AbortController().signal,
    ),
  );

  expect(posted).toBe(true);
  expect(result.isError).toBe(false);
  expect(result.content).not.toContain("Staging");
  expect(String(result.content)).toContain("next message");
});

test("ask_user rejects fewer than 2 options before ever posting", async () => {
  let posted = false;
  const fetchImpl = (async () => {
    posted = true;
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const result = await withFetch(fetchImpl, () =>
    bundle.run(
      {
        id: "call_1",
        name: ASK_USER_TOOL,
        arguments: { question: "Q?", options: ["only one"] },
      },
      new AbortController().signal,
    ),
  );

  expect(posted).toBe(false);
  expect(result.isError).toBe(true);
});

test("ask_user surfaces a no-own-channel failure as an error result, not a throw", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ error: { code: "not_found", message: "no channel" } }),
      { status: 404 },
    )) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const result = await withFetch(fetchImpl, () =>
    bundle.run(
      {
        id: "call_1",
        name: ASK_USER_TOOL,
        arguments: { question: "Q?", options: ["a", "b"] },
      },
      new AbortController().signal,
    ),
  );

  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("no channel");
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
