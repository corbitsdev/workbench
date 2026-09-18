// The non-obvious core of a model-change redeploy: replacing exactly the
// old offering id (and its declared source) in Myra's existing fallback
// chain, preserving order, every other source, and which slot was
// default — or reporting there is nothing to swap at all.

import { describe, expect, test } from "bun:test";

import { swapDeclaredOffering } from "./myra-model-redeploy";

const BEFORE = {
  sourceOfferingIds: ["off_a", "off_b", "off_c"],
  defaultSourceOfferingId: "off_b",
  declaredSources: [
    { provider: "anthropic" as const, model: "claude-sonnet-5" },
    { provider: "openai-compatible" as const, model: "qwen2.5:14b" },
    { provider: "openai" as const, model: "gpt-5" },
  ],
};

describe("swapDeclaredOffering", () => {
  test("replaces the old id in place and its declared source at the same position", () => {
    const result = swapDeclaredOffering(
      BEFORE,
      "off_b",
      "off_new",
      "openai-compatible",
      "qwen2.5:32b",
    );

    expect(result).toEqual({
      sourceOfferingIds: ["off_a", "off_new", "off_c"],
      defaultSourceOfferingId: "off_new",
      declaredSources: [
        { provider: "anthropic", model: "claude-sonnet-5" },
        { provider: "openai-compatible", model: "qwen2.5:32b" },
        { provider: "openai", model: "gpt-5" },
      ],
    });
  });

  test("leaves the default offering id untouched when a non-default offering is swapped", () => {
    const result = swapDeclaredOffering(BEFORE, "off_a", "off_new", "anthropic", "claude-opus-5");

    expect(result?.defaultSourceOfferingId).toBe("off_b");
    expect(result?.sourceOfferingIds).toEqual(["off_new", "off_b", "off_c"]);
  });

  test("returns null when the old offering id isn't declared at all", () => {
    const result = swapDeclaredOffering(
      BEFORE,
      "off_missing",
      "off_new",
      "anthropic",
      "claude-opus-5",
    );

    expect(result).toBeNull();
  });
});
