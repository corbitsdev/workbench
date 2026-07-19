import { describe, expect, test } from "bun:test";

import type { InferenceEvent } from "@intx/types/runtime";

import { factsFromInferenceEvent } from "./event-mapping";
import { sumAnalyticsModelTokens } from "./model-tokens";

const occurredAt = new Date("2026-07-18T00:00:00.000Z");

// CL-3917: reproduces the shape an OpenAI-compatible gateway (Bifrost)
// actually emits reasoning tokens in — `usage.completion_tokens_details.
// reasoning_tokens` on the inference.usage event — and proves it survives
// the full insights path: event -> analytics fact -> per-model token total.
describe("reasoning tokens surface in insights aggregation (CL-3917)", () => {
  test("a usage event carrying reasoning tokens produces a fact whose token total includes them", () => {
    const event: InferenceEvent = {
      type: "inference.usage",
      seq: 4,
      data: {
        usage: {
          input: 200,
          output: 80,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 37,
        },
        source: {
          sourceId: "src_bifrost",
          provider: "openai-compatible",
          model: "deepseek-v4-flash",
        },
      },
    };

    const [fact] = factsFromInferenceEvent({
      agentAddress: "agent@example.test",
      event,
      now: occurredAt,
    });

    expect(fact).toBeDefined();
    expect(fact?.thinkingTokens).toBe(37);

    const totalWithThinking = sumAnalyticsModelTokens({
      inputTokens: fact?.inputTokens,
      outputTokens: fact?.outputTokens,
      cacheReadTokens: fact?.cacheReadTokens,
      cacheWriteTokens: fact?.cacheWriteTokens,
      thinkingTokens: fact?.thinkingTokens,
    });
    const totalWithoutThinking = sumAnalyticsModelTokens({
      inputTokens: fact?.inputTokens,
      outputTokens: fact?.outputTokens,
      cacheReadTokens: fact?.cacheReadTokens,
      cacheWriteTokens: fact?.cacheWriteTokens,
    });

    expect(totalWithThinking).toBe(totalWithoutThinking + 37);
  });
});
