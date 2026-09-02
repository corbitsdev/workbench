// CATALOG_SEEDS is pure data consumed by seedCatalog (seed.ts) to give
// every supported credential provider a browsable, launchable model
// catalog. These tests guard the shape every entry must hold — one seed
// per SupportedCredentialProvider, a small curated model set (Anthropic
// has six; others typically 2–5), and a provider spec whose adapter
// plugin matches credential-test.ts's own mapping — so a newly added
// provider (like xAI) can't silently drift out of sync.
import { describe, expect, test } from "bun:test";

import {
  CATALOG_SEEDS,
  deriveWorkbenchHostInferencePreferences,
} from "../src/catalog-seed-data";
import {
  supportedCredentialProviders,
  type SupportedCredentialProvider,
} from "@workbench/hub-client/credential-test";

describe("CATALOG_SEEDS", () => {
  test("has one seed for every supported credential provider", () => {
    const seededProviders = Object.keys(CATALOG_SEEDS).sort();
    const supportedProviders = supportedCredentialProviders()
      .map((p) => p.id)
      .sort();
    expect(seededProviders).toEqual(supportedProviders);
  });

  test("every non-exception seed stays inside the generic curated-size bound", () => {
    for (const [provider, seed] of Object.entries(CATALOG_SEEDS) as [
      SupportedCredentialProvider,
      (typeof CATALOG_SEEDS)[SupportedCredentialProvider],
    ][]) {
      // Anthropic is the curated six-model set (Sonnet 5 first); openai and
      // google-genai keep their smaller curated lists. Everyone else stays
      // inside the generic 2–5 bound.
      if (provider === "anthropic" || provider === "openai") continue;
      if (provider === "google-genai") continue;
      expect(seed.models.length).toBeGreaterThanOrEqual(2);
      expect(seed.models.length).toBeLessThanOrEqual(5);
    }
  });

  test("no seed plants the same canonical model name twice", () => {
    for (const seed of Object.values(CATALOG_SEEDS)) {
      const names = seed.models.map((m) => m.canonicalName);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("anthropic seeds Claude models behind the anthropic adapter", () => {
    const seed = CATALOG_SEEDS.anthropic;
    expect(seed.provider).toEqual({
      name: "anthropic",
      plugin: "anthropic",
      baseURL: "https://api.anthropic.com",
    });
    expect(seed.models.map((m) => m.canonicalName)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-haiku-4-5-20251001",
      "claude-fable-5",
      "claude-sonnet-4-6",
    ]);
    for (const model of seed.models) {
      expect(model.displayName.length).toBeGreaterThan(0);
    }
  });

  test("xai seeds Grok models behind the openai-compatible adapter", () => {
    const seed = CATALOG_SEEDS.xai;
    expect(seed.provider).toEqual({
      name: "xai",
      plugin: "openai-compatible",
      baseURL: "https://api.x.ai/v1",
    });
    expect(seed.models.map((m) => m.canonicalName)).toEqual([
      "grok-4.6",
      "grok-4.5",
      "grok-code-fast-1",
    ]);
    for (const model of seed.models) {
      expect(model.displayName.length).toBeGreaterThan(0);
    }
  });
});

describe("deriveWorkbenchHostInferencePreferences", () => {
  test("anthropic-only bench prefers its curated default", () => {
    expect(deriveWorkbenchHostInferencePreferences(["anthropic"])).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
  });

  test("openrouter-only bench gets an openrouter preference, not anthropic", () => {
    expect(deriveWorkbenchHostInferencePreferences(["openrouter"])).toEqual([
      { provider: "openrouter", model: "qwen/qwen3.8-27b" },
    ]);
  });

  test("a multi-provider bench orders anthropic first, in CATALOG_SEEDS order otherwise", () => {
    expect(
      deriveWorkbenchHostInferencePreferences([
        "groq",
        "openrouter",
        "anthropic",
      ]),
    ).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "openrouter", model: "qwen/qwen3.8-27b" },
      { provider: "groq", model: "llama-3.3-70b-versatile" },
    ]);
  });

  test("a multi-provider bench without anthropic still orders by CATALOG_SEEDS declaration", () => {
    expect(
      deriveWorkbenchHostInferencePreferences(["huggingface", "xai"]),
    ).toEqual([
      { provider: "xai", model: "grok-4.6" },
      {
        provider: "huggingface",
        model: "deepseek-ai/DeepSeek-V4-Flash",
      },
    ]);
  });

  test("a bench with zero connected providers gets an empty, honest list", () => {
    expect(deriveWorkbenchHostInferencePreferences([])).toEqual([]);
  });

  test("an unrecognized provider name is dropped, not guessed at", () => {
    expect(
      deriveWorkbenchHostInferencePreferences(["not-a-real-provider"]),
    ).toEqual([]);
  });
});
