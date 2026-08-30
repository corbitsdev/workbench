import { describe, expect, test } from "bun:test";
import { createOpenAIAdapter } from "@intx/inference/providers";
import type { LastCycleSource } from "@intx/types/runtime";
import type {
  ConversationTurn,
  InferenceEvent,
  InferenceOptions,
  ToolDefinition,
} from "@intx/types/runtime";

import { createOllamaAdapter } from "./adapter";

const source: LastCycleSource = {
  sourceId: "ollama-test",
  provider: "ollama",
  model: "gpt-oss:20b",
};

const messages: ConversationTurn[] = [
  {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: 0,
  },
];

const options: InferenceOptions = {};

const memorySearchTool: ToolDefinition = {
  name: "memory_search",
  description: "Search firm memory",
  inputSchema: { type: "object" },
};

const CL_7186_PAYLOAD =
  '{"name":"memory_search","parameters":{"query":"this person"}}';

function bodyOf(built: { body: string }): Record<string, unknown> {
  return JSON.parse(built.body) as Record<string, unknown>;
}

function toolStarts(events: readonly InferenceEvent[]): InferenceEvent[] {
  return events.filter((event) => event.type === "inference.tool_call.start");
}

function textDeltas(events: readonly InferenceEvent[]): InferenceEvent[] {
  return events.filter((event) => event.type === "inference.text.delta");
}

function argumentFragments(events: readonly InferenceEvent[]): string {
  return events
    .filter((event) => event.type === "inference.tool_call.delta")
    .map(
      (event) => (event.data as { argumentFragment: string }).argumentFragment,
    )
    .join("");
}

function expectSharedToolCallId(events: readonly InferenceEvent[]): void {
  const ids = events
    .filter(
      (event) =>
        event.type === "inference.tool_call.start" ||
        event.type === "inference.tool_call.delta",
    )
    .map((event) => (event.data as { callId: string }).callId);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids)).toEqual(new Set(["ollama-inline-0"]));
}

describe("createOllamaAdapter", () => {
  test("no override configured leaves the body equivalent to the built-in adapter's", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    const inner = createOpenAIAdapter(source);
    const wrappedBuilt = wrapped.buildRequest(messages, "gpt-oss:20b", options);
    const innerBuilt = inner.buildRequest(messages, "gpt-oss:20b", options);
    expect(bodyOf(wrappedBuilt)).toEqual(bodyOf(innerBuilt));
    expect(wrappedBuilt.url).toBe(innerBuilt.url);
    expect(wrappedBuilt.headers).toEqual(innerBuilt.headers);
  });

  test("a configured num_ctx and max output tokens appear in the built request body", () => {
    const wrapped = createOllamaAdapter(source, {
      default: { numCtx: 32768, maxOutputTokens: 2048 },
    });
    const built = wrapped.buildRequest(messages, "gpt-oss:20b", options);
    const body = bodyOf(built);
    expect(body["options"]).toEqual({ num_ctx: 32768 });
    expect(body["max_tokens"]).toBe(2048);
  });

  test("a configured reasoning effort appears in the built request body", () => {
    const wrapped = createOllamaAdapter(source, {
      default: { reasoningEffort: "high" },
    });
    const built = wrapped.buildRequest(messages, "gpt-oss:20b", options);
    expect(bodyOf(built)["reasoning_effort"]).toBe("high");
  });

  test("a per-model override beats the general default", () => {
    const wrapped = createOllamaAdapter(source, {
      default: { numCtx: 8192 },
      perModel: { "gpt-oss:20b": { numCtx: 65536 } },
    });
    const forOverriddenModel = bodyOf(
      wrapped.buildRequest(messages, "gpt-oss:20b", options),
    );
    const forOtherModel = bodyOf(
      wrapped.buildRequest(messages, "qwen3.8:27b", options),
    );
    expect(forOverriddenModel["options"]).toEqual({ num_ctx: 65536 });
    expect(forOtherModel["options"]).toEqual({ num_ctx: 8192 });
  });

  test("preserves the built-in adapter's response parsing and header extractors", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    const chunk = JSON.stringify({
      choices: [{ delta: { content: "hi" } }],
    });
    expect(wrapped.parseResponse(chunk)).toEqual([
      {
        type: "inference.text.delta",
        seq: 0,
        data: { token: "hi", partial: { text: "" }, index: 0 },
      },
    ]);
    expect(typeof wrapped.extractRetryAfterMs).toBe("function");
    expect(typeof wrapped.extractPacingDelayMs).toBe("function");
  });

  test("parseResponse salvages declared inline memory_search JSON into a tool call", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    wrapped.buildRequest(messages, "gpt-oss:20b", {
      tools: [memorySearchTool],
    });
    const events = [
      ...wrapped.parseResponse(
        JSON.stringify({
          choices: [{ delta: { content: CL_7186_PAYLOAD } }],
        }),
      ),
      ...wrapped.parseResponse(
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
        }),
      ),
    ];
    expect(textDeltas(events)).toEqual([]);
    expect((toolStarts(events)[0]?.data as { name: string }).name).toBe(
      "memory_search",
    );
    expectSharedToolCallId(events);
    expect(JSON.parse(argumentFragments(events))).toEqual({
      query: "this person",
    });
  });

  test("parseJSONResponse salvages declared inline memory_search JSON into a tool call", () => {
    const wrapped = createOllamaAdapter(source, undefined);
    wrapped.buildRequest(messages, "gpt-oss:20b", {
      tools: [memorySearchTool],
    });
    const events = wrapped.parseJSONResponse(
      JSON.stringify({
        object: "chat.completion",
        choices: [
          {
            message: { role: "assistant", content: CL_7186_PAYLOAD },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    expect(textDeltas(events)).toEqual([]);
    expect((toolStarts(events)[0]?.data as { name: string }).name).toBe(
      "memory_search",
    );
    expectSharedToolCallId(events);
    expect(JSON.parse(argumentFragments(events))).toEqual({
      query: "this person",
    });
  });
});
