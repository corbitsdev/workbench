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

  test("drops the duplicate when the new offering is already declared", () => {
    // The new offering is minted before the current list is read, so the
    // swap would otherwise declare it twice and the hub rejects that.
    const before = {
      sourceOfferingIds: ["off_old", "off_new"],
      defaultSourceOfferingId: "off_old",
      declaredSources: [
        { provider: "openai-compatible" as const, model: "qwen2.5:7b" },
        { provider: "openai-compatible" as const, model: "llama3.2:1b" },
      ],
    };

    const result = swapDeclaredOffering(
      before,
      "off_old",
      "off_new",
      "openai-compatible",
      "llama3.2:1b",
    );

    expect(result).toEqual({
      sourceOfferingIds: ["off_new"],
      defaultSourceOfferingId: "off_new",
      declaredSources: [{ provider: "openai-compatible", model: "llama3.2:1b" }],
    });
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
