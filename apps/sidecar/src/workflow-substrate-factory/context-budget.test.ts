// Tests for the CL-6204 context-budget resolver: reads a per-model
// `numCtx` hint off an `InferenceSource.quirks` bag shaped like
// `@corbits/ollama-adapter`'s `OllamaAdapterConfig`, falling back to a
// conservative default for any other shape.
import { expect, test } from "bun:test";

import {
  readNumCtxHint,
  resolveContextBudgetChars,
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

test("resolveContextBudgetChars: unknown model falls back to the conservative default", () => {
  const withoutQuirks = resolveContextBudgetChars(undefined, "unknown-model");

  expect(withoutQuirks).toBeGreaterThan(0);
  expect(Number.isFinite(withoutQuirks)).toBe(true);
});

test("resolveHardContextLimitChars: sits above the headroomed budget for the same source", () => {
  const quirks = { default: { numCtx: 32_000 } };

  const budget = resolveContextBudgetChars(quirks, "m");
  const hardLimit = resolveHardContextLimitChars(quirks, "m");

  expect(hardLimit).toBeGreaterThan(budget);
});
