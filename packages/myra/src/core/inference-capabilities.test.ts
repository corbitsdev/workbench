import { describe, expect, test } from "bun:test";
import {
  getModelInferenceCapabilities,
  listKnownModelInferenceCapabilities,
  normalizeModelSlugForCapabilities,
} from "./inference-capabilities";

describe("inference capabilities matrix", () => {
  test("lists four known models", () => {
    const rows = listKnownModelInferenceCapabilities();
    expect(rows.map((r) => r.modelSlug).sort()).toEqual([
      "claude-opus-4-8",
      "deepseek-v4-flash",
      "kimi-k2.6",
      "kimi-k3",
    ]);
  });

  test("normalizes provider model ids", () => {
    expect(normalizeModelSlugForCapabilities("anthropic/claude-opus-4-8")).toBe(
      "claude-opus-4-8",
    );
    expect(getModelInferenceCapabilities("moonshot/kimi-k2.6")?.creative).toBe(
      "temperature",
    );
    expect(
      getModelInferenceCapabilities("deepseek/deepseek-v4-flash")?.thinking,
    ).toBe("hidden");
  });

  test("normalizes kimi-k3 to its own matrix entry, not kimi-k2.6", () => {
    expect(normalizeModelSlugForCapabilities("kimi-k3")).toBe("kimi-k3");
    expect(normalizeModelSlugForCapabilities("moonshot/kimi-k3")).toBe(
      "kimi-k3",
    );
    expect(getModelInferenceCapabilities("kimi-k3")?.thinking).toBe(
      "thinking_toggle",
    );
    expect(getModelInferenceCapabilities("kimi-k3")?.creative).toBe(
      "temperature",
    );
  });

  test("flags temperature/thinking exclusivity for kimi and opus", () => {
    expect(
      getModelInferenceCapabilities("kimi-k2.6")?.temperatureThinkingExclusive,
    ).toBe(true);
    expect(
      getModelInferenceCapabilities("kimi-k3")?.temperatureThinkingExclusive,
    ).toBe(true);
    expect(
      getModelInferenceCapabilities("deepseek-v4-flash")
        ?.temperatureThinkingExclusive,
    ).toBe(false);
  });
});
