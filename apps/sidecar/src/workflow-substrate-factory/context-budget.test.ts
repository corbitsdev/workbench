// Tests for the context-budget resolver: quirks `numCtx` pin, then the
// advertised catalog window for the model name, never a baked 8k-token
// (32k-char) cap for frontier models.
import { expect, test } from "bun:test";

import {
  advertisedContextWindowTokens,
  readNumCtxHint,
  resolveContextBudgetChars,
  resolveContextWindowTokens,
  resolveHardContextLimitChars,
} from "./context-budget";

test("readNumCtxHint: reads a per-model override over the default", () => {
  const quirks = {
    default: { numCtx: 8_000 },
    perModel: { "gpt-oss:20b": { numCtx: 128_000 } },
  };

  expect(readNumCtxHint(quirks, "gpt-oss:20b")).toBe(128_000);
  expect(readNumCtxHint(quirks, "other-model")).toBe(8_000);
});

test("readNumCtxHint: unrecognized or absent quirks resolve to undefined", () => {
  expect(readNumCtxHint(undefined, "claude")).toBeUndefined();
  expect(readNumCtxHint(null, "claude")).toBeUndefined();
  expect(readNumCtxHint({ unrelated: true }, "claude")).toBeUndefined();
  expect(readNumCtxHint("not-an-object", "claude")).toBeUndefined();
});

test("readNumCtxHint: a top-level numCtx pin is visible without the Ollama bag shape", () => {
  expect(readNumCtxHint({ numCtx: 200_000 }, "claude-sonnet-5")).toBe(200_000);
});

test("resolveContextBudgetChars: a bigger numCtx yields a bigger budget", () => {
  const small = resolveContextBudgetChars(
    { default: { numCtx: 32_000 } },
    "qwen3",
  );
  const large = resolveContextBudgetChars(
    { default: { numCtx: 128_000 } },
    "gpt-oss:20b",
  );

  expect(large).toBeGreaterThan(small);
});

test("resolveContextWindowTokens: quirks pin wins over the advertised catalog window", () => {
  expect(
    resolveContextWindowTokens(
      { default: { numCtx: 8_192 } },
      "claude-sonnet-5",
    ),
  ).toBe(8_192);
});

test("resolveContextWindowTokens: a frontier catalog model gets its advertised window, not a 32k-char cap", () => {
  const claudeTokens = resolveContextWindowTokens(undefined, "claude-sonnet-5");
  const claudeHard = resolveHardContextLimitChars(undefined, "claude-sonnet-5");
  const oldDefaultHardChars = 8_000 * 4;

  expect(claudeTokens).toBe(200_000);
  expect(claudeHard).toBeGreaterThan(oldDefaultHardChars);
  expect(claudeHard).toBe(200_000 * 4);
});

test("resolveContextWindowTokens: an Ollama catalog model gets its native window without quirks", () => {
  expect(resolveContextWindowTokens(undefined, "gpt-oss:20b")).toBe(131_072);
  expect(resolveContextWindowTokens(undefined, "qwen3.8:27b")).toBe(32_768);
  expect(
    resolveHardContextLimitChars(undefined, "gpt-oss:20b"),
  ).toBeGreaterThan(resolveHardContextLimitChars(undefined, "qwen3.8:27b"));
});

test("advertisedContextWindowTokens: a relay-prefixed name still matches the catalog model", () => {
  expect(advertisedContextWindowTokens("anthropic/claude-sonnet-5")).toBe(
    200_000,
  );
  expect(advertisedContextWindowTokens("openai/gpt-4.1")).toBe(1_047_576);
});

test("resolveContextBudgetChars: unknown model falls back to a hosted-sized window, not 8k tokens", () => {
  const withoutQuirks = resolveContextBudgetChars(undefined, "unknown-model");
  const hard = resolveHardContextLimitChars(undefined, "unknown-model");

  expect(withoutQuirks).toBeGreaterThan(0);
  expect(Number.isFinite(withoutQuirks)).toBe(true);
  expect(hard).toBeGreaterThan(8_000 * 4);
  expect(hard).toBe(128_000 * 4);
});

test("resolveHardContextLimitChars: sits above the headroomed budget for the same source", () => {
  const quirks = { default: { numCtx: 32_000 } };

  const budget = resolveContextBudgetChars(quirks, "m");
  const hardLimit = resolveHardContextLimitChars(quirks, "m");

  expect(hardLimit).toBeGreaterThan(budget);
});
