import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  ModelsDevPayloadSchema,
  buildPriceCatalog,
  computeCost,
  priceUsageRows,
  resolveModelRate,
  UNKNOWN_MODEL_LABEL,
  type ModelsDevPayload,
  type PriceCatalog,
} from "./catalog";

const SAMPLE: ModelsDevPayload = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4-5": {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    models: {
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
      },
    },
  },
  local: {
    id: "local",
    name: "Local",
    models: {
      "llama-local": { id: "llama-local", name: "Llama (local)" },
    },
  },
};

function catalog(): PriceCatalog {
  return buildPriceCatalog(SAMPLE, "test", "2026-07-03T00:00:00.000Z");
}

describe("buildPriceCatalog", () => {
  test("keeps only models that publish at least one rate", () => {
    const c = catalog();
    expect(Object.keys(c.models).sort()).toEqual([
      "claude-opus-4-5",
      "deepseek-v4-flash",
    ]);
    expect(c.models["llama-local"]).toBeUndefined();
  });

  test("carries provider identity and null for unpublished classes", () => {
    const rate = catalog().models["deepseek-v4-flash"];
    expect(rate).toBeDefined();
    expect(rate?.provider).toBe("deepseek");
    expect(rate?.providerName).toBe("DeepSeek");
    expect(rate?.cacheRead).toBe(0.0028);
    // deepseek publishes no cache_write → null, never 0
    expect(rate?.cacheWrite).toBeNull();
  });

  test("prefers a rated duplicate over a rate-less one across providers", () => {
    const payload: ModelsDevPayload = {
      zzz: {
        id: "zzz",
        name: "Z",
        models: { dupe: { id: "dupe", name: "Dupe" } },
      },
      aaa: {
        id: "aaa",
        name: "A",
        models: { dupe: { id: "dupe", name: "Dupe", cost: { input: 2 } } },
      },
    };
    const c = buildPriceCatalog(payload, "t", "now");
    expect(c.models["dupe"]?.input).toBe(2);
    expect(c.models["dupe"]?.provider).toBe("aaa");
  });

  test("marks a bare id priced differently by two providers as ambiguous", () => {
    const payload: ModelsDevPayload = {
      groq: {
        id: "groq",
        name: "Groq",
        models: {
          "llama-3.3-70b": {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            cost: { input: 0.59, output: 0.79 },
          },
        },
      },
      together: {
        id: "together",
        name: "Together",
        models: {
          "llama-3.3-70b": {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            cost: { input: 0.88, output: 0.88 },
          },
        },
      },
    };
    const c = buildPriceCatalog(payload, "t", "now");
    // Ambiguous: dropped from the bare map, both provider variants kept.
    expect(c.models["llama-3.3-70b"]).toBeUndefined();
    expect(c.ambiguous).toContain("llama-3.3-70b");
    expect(c.qualified["groq/llama-3.3-70b"]?.input).toBe(0.59);
    expect(c.qualified["together/llama-3.3-70b"]?.input).toBe(0.88);
  });

  test("an identical rate under two providers is not ambiguous", () => {
    const payload: ModelsDevPayload = {
      groq: {
        id: "groq",
        name: "Groq",
        models: {
          "llama-x": { id: "llama-x", name: "Llama X", cost: { input: 1 } },
        },
      },
      together: {
        id: "together",
        name: "Together",
        models: {
          "llama-x": { id: "llama-x", name: "Llama X", cost: { input: 1 } },
        },
      },
    };
    const c = buildPriceCatalog(payload, "t", "now");
    expect(c.ambiguous).not.toContain("llama-x");
    expect(c.models["llama-x"]?.input).toBe(1);
  });
});

describe("resolveModelRate provider collisions (CL-2714)", () => {
  const payload: ModelsDevPayload = {
    groq: {
      id: "groq",
      name: "Groq",
      models: {
        "llama-3.3-70b": {
          id: "llama-3.3-70b",
          name: "Llama 3.3 70B",
          cost: { input: 0.59, output: 0.79 },
        },
      },
    },
    together: {
      id: "together",
      name: "Together",
      models: {
        "llama-3.3-70b": {
          id: "llama-3.3-70b",
          name: "Llama 3.3 70B",
          cost: { input: 0.88, output: 0.88 },
        },
      },
    },
  };
  const collision = (): PriceCatalog => buildPriceCatalog(payload, "t", "now");

  test("a provider-qualified id resolves to THAT provider's rate", () => {
    expect(resolveModelRate(collision(), "groq/llama-3.3-70b")?.input).toBe(
      0.59,
    );
    expect(resolveModelRate(collision(), "together/llama-3.3-70b")?.input).toBe(
      0.88,
    );
  });

  test("a bare ambiguous id returns null, never a guessed provider", () => {
    expect(resolveModelRate(collision(), "llama-3.3-70b")).toBeNull();
  });

  test("a qualified id for an unknown provider falls back to the bare id", () => {
    // Bare id is ambiguous, so even the fallback is honestly null.
    expect(resolveModelRate(collision(), "fireworks/llama-3.3-70b")).toBeNull();
  });
});

describe("resolveModelRate", () => {
  test("exact match", () => {
    expect(resolveModelRate(catalog(), "claude-opus-4-5")?.input).toBe(5);
  });

  test("case-insensitive match", () => {
    expect(resolveModelRate(catalog(), "Claude-Opus-4-5")?.output).toBe(25);
  });

  test("provider-prefixed name strips to bare id", () => {
    expect(
      resolveModelRate(catalog(), "anthropic/claude-opus-4-5")?.input,
    ).toBe(5);
  });

  test("unknown model returns null (no fabricated rate)", () => {
    expect(resolveModelRate(catalog(), "claude-opus-4-8")).toBeNull();
    expect(resolveModelRate(catalog(), null)).toBeNull();
    expect(resolveModelRate(catalog(), "")).toBeNull();
  });
});

describe("computeCost", () => {
  test("prices each token class independently, in dollars", () => {
    const rate = resolveModelRate(catalog(), "claude-opus-4-5");
    const cost = computeCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 100_000,
        thinkingTokens: 0,
      },
      rate,
    );
    // 1M*5 + 0.5M*25 + 2M*0.5 + 0.1M*6.25 = 5 + 12.5 + 1 + 0.625
    expect(cost).not.toBeNull();
    expect(cost?.input).toBeCloseTo(5, 6);
    expect(cost?.output).toBeCloseTo(12.5, 6);
    expect(cost?.cacheRead).toBeCloseTo(1, 6);
    expect(cost?.cacheWrite).toBeCloseTo(0.625, 6);
    expect(cost?.total).toBeCloseTo(19.125, 6);
  });

  test("a class with a null rate contributes zero, not a guess", () => {
    const rate = resolveModelRate(catalog(), "deepseek-v4-flash");
    const cost = computeCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 1_000_000,
        thinkingTokens: 0,
      },
      rate,
    );
    expect(cost?.cacheWrite).toBe(0);
    expect(cost?.total).toBe(0);
  });

  test("no rate → null (unpriced model)", () => {
    expect(
      computeCost(
        {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
        },
        null,
      ),
    ).toBeNull();
  });

  test("thinking tokens are priced at the model's output rate (CL-2723)", () => {
    const rate = resolveModelRate(catalog(), "claude-opus-4-5");
    const cost = computeCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 200_000,
      },
      rate,
    );
    // 0.2M * $25/M output rate = $5
    expect(cost?.thinking).toBeCloseTo(5, 6);
    expect(cost?.total).toBeCloseTo(5, 6);
  });

  test("thinking tokens with no rate contribute zero, matching the output class", () => {
    const rate = resolveModelRate(catalog(), "deepseek-v4-flash");
    const cost = computeCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 1_000_000,
      },
      rate,
    );
    // deepseek-v4-flash DOES publish output ($0.28/M) in the fixture, so this
    // asserts the thinking class truly reuses the resolved output rate.
    expect(cost?.thinking).toBeCloseTo(0.28, 6);
  });
});

describe("priceUsageRows", () => {
  test("sums priced rows and reports unpriced models with usage", () => {
    const result = priceUsageRows(
      [
        {
          model: "claude-opus-4-5",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
        },
        {
          model: "mystery-model",
          inputTokens: 5_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
        },
      ],
      catalog(),
    );
    expect(result.cost.total).toBeCloseTo(5, 6);
    expect(result.hasUnpriced).toBe(true);
    expect(result.unpricedModels).toEqual(["mystery-model"]);
  });

  test("an unpriced model with zero tokens is not flagged", () => {
    const result = priceUsageRows(
      [
        {
          model: "mystery-model",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
        },
      ],
      catalog(),
    );
    expect(result.hasUnpriced).toBe(false);
    expect(result.cost.total).toBe(0);
  });

  test("an unpriced model flagged solely by thinking-token usage", () => {
    const result = priceUsageRows(
      [
        {
          model: "mystery-model",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 42,
        },
      ],
      catalog(),
    );
    expect(result.hasUnpriced).toBe(true);
    expect(result.unpricedModels).toEqual(["mystery-model"]);
  });

  test("null-model usage under UNKNOWN_MODEL_LABEL is unpriced, never a silent $0 (CL-2723)", () => {
    const result = priceUsageRows(
      [
        {
          model: UNKNOWN_MODEL_LABEL,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
        },
      ],
      catalog(),
    );
    expect(result.hasUnpriced).toBe(true);
    expect(result.unpricedModels).toEqual([UNKNOWN_MODEL_LABEL]);
    expect(result.cost.total).toBe(0);
  });

  test("sums cost across multiple priced rows for the same and different models", () => {
    const result = priceUsageRows(
      [
        {
          model: "claude-opus-4-5",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
        },
        {
          model: "claude-opus-4-5",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
        },
        {
          model: "deepseek-v4-flash",
          inputTokens: 0,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
        },
      ],
      catalog(),
    );
    // Two claude-opus-4-5 rows at $5/M input = $10, plus deepseek output $0.28/M = $0.28
    expect(result.cost.input).toBeCloseTo(10, 6);
    expect(result.cost.output).toBeCloseTo(0.28, 6);
    expect(result.cost.total).toBeCloseTo(10.28, 6);
    expect(result.hasUnpriced).toBe(false);
  });
});

describe("ModelsDevPayloadSchema boundary parse", () => {
  test("accepts a well-formed payload", () => {
    const parsed = ModelsDevPayloadSchema(SAMPLE);
    expect(parsed instanceof type.errors).toBe(false);
  });

  test("rejects a malformed payload (non-numeric cost)", () => {
    const bad = {
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        models: {
          "claude-x": { id: "claude-x", cost: { input: "three dollars" } },
        },
      },
    };
    const parsed = ModelsDevPayloadSchema(bad);
    expect(parsed instanceof type.errors).toBe(true);
  });

  test("rejects a provider missing its models map", () => {
    const bad = { anthropic: { id: "anthropic", name: "Anthropic" } };
    const parsed = ModelsDevPayloadSchema(bad);
    expect(parsed instanceof type.errors).toBe(true);
  });
});
