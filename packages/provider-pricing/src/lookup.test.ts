import { describe, expect, test } from "bun:test";

import { costUsd, lookupRates } from "./lookup";

const millionInput = {
  input: 1_000_000,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  thinking: 0,
};

describe("lookupRates", () => {
  test("anthropic claude-sonnet-5 is not zen claude-sonnet-5", () => {
    const anthropic = lookupRates({
      provider: "anthropic",
      model: "claude-sonnet-5",
      contextTokens: 1_000,
    });
    const zen = lookupRates({
      provider: "opencode-zen",
      model: "claude-sonnet-5",
      contextTokens: 1_000,
    });
    expect(anthropic?.inputPerMTok).toBe(2);
    expect(zen?.inputPerMTok).toBe(1.7);
  });

  test("unknown pair is null", () => {
    expect(
      lookupRates({
        provider: "anthropic",
        model: "mystery-model",
        contextTokens: 1,
      }),
    ).toBeNull();
  });

  test("catalog model with no price row is null, not a guess", () => {
    // "gpt-5" is a real @intx/inference-catalog model served by OpenAI
    // Direct, but workbench has no priced row for it — an unpriced
    // catalog model is an expected, honest absence, not a silent gap.
    expect(
      lookupRates({
        provider: "openai",
        model: "gpt-5",
        contextTokens: 1_000,
      }),
    ).toBeNull();
  });

  test("openai gpt-5.6-terra steps up at 272k context", () => {
    const below = lookupRates({
      provider: "openai",
      model: "gpt-5.6-terra",
      contextTokens: 271_999,
    });
    const at = lookupRates({
      provider: "openai",
      model: "gpt-5.6-terra",
      contextTokens: 272_000,
    });
    expect(below?.inputPerMTok).toBe(2);
    expect(at?.inputPerMTok).toBe(4);
  });

  test("xai grok-4.6 steps up at 200k context", () => {
    const below = lookupRates({
      provider: "xai",
      model: "grok-4.6",
      contextTokens: 199_999,
    });
    const at = lookupRates({
      provider: "xai",
      model: "grok-4.6",
      contextTokens: 200_000,
    });
    expect(below?.outputPerMTok).toBe(6);
    expect(at?.outputPerMTok).toBe(12);
  });
});

describe("costUsd", () => {
  test("1M anthropic sonnet-5 input is $2", () => {
    expect(
      costUsd({
        provider: "anthropic",
        model: "claude-sonnet-5",
        tokens: millionInput,
      }),
    ).toBe(2);
  });

  test("unknown model with tokens is null, not zero", () => {
    expect(
      costUsd({
        provider: "anthropic",
        model: "mystery-model",
        tokens: millionInput,
      }),
    ).toBeNull();
  });

  test("unknown model with zero tokens is $0", () => {
    expect(
      costUsd({
        provider: "anthropic",
        model: "mystery-model",
        tokens: {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          thinking: 0,
        },
      }),
    ).toBe(0);
  });

  test("ollama is $0", () => {
    expect(
      costUsd({
        provider: "ollama",
        model: "qwen3.8:27b",
        tokens: millionInput,
      }),
    ).toBe(0);
  });
});
