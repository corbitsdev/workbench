import { describe, expect, test } from "bun:test";

import type { InferenceEvent } from "@intx/types/runtime";

import { factsFromInferenceEvent } from "./event-mapping";
import { sumAnalyticsModelTokens } from "./model-tokens";

const occurredAt = new Date("2026-07-18T00:00:00.000Z");

// CL-3917: reproduces the shape an OpenAI-compatible gateway (Bifrost)
// actually emits reasoning tokens in — `usage.completion_tokens_details.
// reasoning_tokens` on the inference.usage event. Covers the usage-event
// mapping through factsFromInferenceEvent + sumAnalyticsModelTokens, i.e.
// that thinkingTokens is mapped and summed correctly once present on a
// fact. It does NOT cover the rollup/dashboard-total path: inference_usage
// facts are excluded from rollup contribution in subscriber.ts's
// persistFact (stored for auditing only); dashboard totals ride
// inference.done's finalUsage, built by harness.ts folding adapter usage
// events through mergeUsage — that fold is where this PR's adapter fix
// actually reaches insights, not the path exercised here.
describe("reasoning-token usage-event mapping and summing (CL-3917)", () => {
  test("a usage event carrying reasoning tokens maps to a fact whose token total includes them", () => {
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

    if (fact === undefined) throw new Error("expected a usage fact");
    expect(fact.thinkingTokens).toBe(37);

    const totalWithThinking = sumAnalyticsModelTokens({
      inputTokens: fact.inputTokens,
      outputTokens: fact.outputTokens,
      cacheReadTokens: fact.cacheReadTokens,
      cacheWriteTokens: fact.cacheWriteTokens,
      thinkingTokens: fact.thinkingTokens,
    });
    const totalWithoutThinking = sumAnalyticsModelTokens({
      inputTokens: fact.inputTokens,
      outputTokens: fact.outputTokens,
      cacheReadTokens: fact.cacheReadTokens,
      cacheWriteTokens: fact.cacheWriteTokens,
    });

    expect(totalWithThinking).toBe(totalWithoutThinking + 37);
  });
});
