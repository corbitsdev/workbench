import { expect, test } from "bun:test";

import { callEvalModel } from "./model-call.ts";
import type { FetchLike } from "./model-call.ts";

test("callEvalModel posts to the Anthropic Messages API and extracts the text block", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: "hello there" }] }),
      { status: 200 },
    );
  };

  const result = await callEvalModel(
    "say hi",
    "test-key",
    undefined,
    fetchImpl,
  );

  expect(result.text).toBe("hello there");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  const body = JSON.parse((calls[0]?.init.body as string) ?? "{}") as {
    model: string;
    messages: { role: string; content: string }[];
  };
  expect(body.model).toBe("claude-3-5-haiku-20241022");
  expect(body.messages).toEqual([{ role: "user", content: "say hi" }]);
});

test("callEvalModel honors an explicit model override", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
      status: 200,
    });
  const result = await callEvalModel(
    "prompt",
    "test-key",
    "claude-3-opus-20240229",
    fetchImpl,
  );
  expect(result.text).toBe("ok");
});

test("callEvalModel returns empty text when no text block is present", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ content: [] }), { status: 200 });
  const result = await callEvalModel(
    "prompt",
    "test-key",
    undefined,
    fetchImpl,
  );
  expect(result.text).toBe("");
});
