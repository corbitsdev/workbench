import { describe, expect, test } from "bun:test";
import type { LastCycleSource } from "@intx/types/runtime";
import { createOpenAIAdapter } from "./openai";

const TEST_SOURCE: LastCycleSource = {
  sourceId: "test-openai",
  provider: "openai",
  model: "test-openai-model",
};

// CL-3917: Bifrost (and other OpenAI-compatible gateways) attach the final
// `usage` object to the SAME SSE chunk that carries the last `choices` delta
// (typically an empty delta with `finish_reason: "stop"`), not to a separate
// usage-only chunk with no `choices` at all. The parser has two separate
// branches that build a TokenUsage from `chunk.usage`: one for chunks with no
// `choices` (correctly reads `completion_tokens_details.reasoning_tokens`)
// and one for chunks that DO carry `choices` (hardcodes `thinking: 0`).
describe("openai adapter reasoning-token usage mapping (CL-3917)", () => {
  test("maps completion_tokens_details.reasoning_tokens when usage rides on a chunk with choices", () => {
    const adapter = createOpenAIAdapter(TEST_SOURCE);
    const sseData = JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 64 },
        completion_tokens_details: { reasoning_tokens: 37 },
      },
    });

    const events = adapter.parseResponse(sseData);
    const usageEvent = events.find((e) => e.type === "inference.usage");

    expect(usageEvent).toBeDefined();
    expect(usageEvent?.data.usage.thinking).toBe(37);
    expect(usageEvent?.data.usage.cacheRead).toBe(64);
  });

  test("maps completion_tokens_details.reasoning_tokens on a usage-only chunk (no choices)", () => {
    const adapter = createOpenAIAdapter(TEST_SOURCE);
    const sseData = JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 22 },
      },
    });

    const events = adapter.parseResponse(sseData);
    const usageEvent = events.find((e) => e.type === "inference.usage");

    expect(usageEvent).toBeDefined();
    expect(usageEvent?.data.usage.thinking).toBe(22);
  });
});
