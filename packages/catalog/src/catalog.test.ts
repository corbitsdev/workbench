import { describe, expect, it } from "bun:test";
import { FULL_CATALOG, buildAgentCatalog } from "./catalog";

describe("FULL_CATALOG integrity", () => {
  it("has no duplicate provider names", () => {
    const names = FULL_CATALOG.providers.map((p) => p.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it("has no duplicate model canonicalNames", () => {
    const names = FULL_CATALOG.models.map((m) => m.canonicalName);
    expect(names.length).toBe(new Set(names).size);
  });

  it("has no duplicate (model, provider) offering pairs", () => {
    const keys = FULL_CATALOG.offerings.map((o) => `${o.model} ${o.provider}`);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("every offering provider exists in providers", () => {
    const providerNames = new Set(FULL_CATALOG.providers.map((p) => p.name));
    for (const offering of FULL_CATALOG.offerings) {
      expect(providerNames.has(offering.provider)).toBe(true);
    }
  });

  it("every offering model exists in models", () => {
    const modelNames = new Set(FULL_CATALOG.models.map((m) => m.canonicalName));
    for (const offering of FULL_CATALOG.offerings) {
      expect(modelNames.has(offering.model)).toBe(true);
    }
  });
});

describe("Bifrost is the primary inference source", () => {
  const offerings = FULL_CATALOG.offerings;
  const isBifrost = (provider: string) =>
    provider.startsWith("corbits-default-bifrost");

  const bifrostOfferingsFor = (model: string) =>
    offerings.filter((o) => o.model === model && isBifrost(o.provider));

  // Direct providers Bifrost proxies (near-ai is Bifrost-independent).
  const PROXYABLE_DIRECT = new Set([
    "opencode-zen",
    "anthropic-api",
    "google-ai",
    "OpenAI",
  ]);

  it("gives every model at most one Bifrost offering", () => {
    const models = [...new Set(offerings.map((o) => o.model))];
    for (const model of models) {
      expect(bifrostOfferingsFor(model).length).toBeLessThanOrEqual(1);
    }
  });

  it("gives every Bifrost-proxyable model exactly one Bifrost head", () => {
    const models = [
      ...new Set(
        offerings
          .filter((o) => PROXYABLE_DIRECT.has(o.provider))
          .map((o) => o.model),
      ),
    ];
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(bifrostOfferingsFor(model).length).toBe(1);
    }
  });

  it("orders the openai-compatible direct ahead of the native direct in the fallback tail", () => {
    const OPENAI_COMPAT_DIRECT = new Set(["opencode-zen", "near-ai"]);
    const NATIVE_DIRECT = new Set(["anthropic-api", "OpenAI", "google-ai"]);
    let comparedPairs = 0;
    for (const offering of offerings) {
      if (!OPENAI_COMPAT_DIRECT.has(offering.provider)) continue;
      const natives = offerings.filter(
        (o) => o.model === offering.model && NATIVE_DIRECT.has(o.provider),
      );
      for (const native of natives) {
        comparedPairs += 1;
        expect(offering.priority as number).toBeLessThan(
          native.priority as number,
        );
      }
    }
    expect(comparedPairs).toBeGreaterThan(0);
  });

  it("orders the Bifrost head ahead of every direct provider for the same model", () => {
    for (const offering of offerings) {
      if (!isBifrost(offering.provider)) continue;
      expect(offering.priority).toBeDefined();
      const fallbacks = offerings.filter(
        (o) => o.model === offering.model && !isBifrost(o.provider),
      );
      expect(fallbacks.length).toBeGreaterThan(0);
      for (const fallback of fallbacks) {
        expect(fallback.priority).toBeDefined();
        expect(offering.priority as number).toBeLessThan(
          fallback.priority as number,
        );
      }
    }
  });

  it("assigns an explicit priority to every offering", () => {
    for (const offering of offerings) {
      expect(typeof offering.priority).toBe("number");
    }
  });
});

describe("buildAgentCatalog", () => {
  it("returns empty providers/models/offerings for empty templates", () => {
    const result = buildAgentCatalog([]);
    expect(result.providers).toEqual([]);
    expect(result.models).toEqual([]);
    expect(result.offerings).toEqual([]);
  });

  it("produces correct output for a template with a known credential", () => {
    const template = {
      key: "test-agent",
      credentialRequirements: [
        {
          source: "tenant",
          providerName: "openai-compatible",
          name: "opencode-zen",
        },
      ],
      modelConfig: { defaultModel: "deepseek-v4-flash" },
    };

    const result = buildAgentCatalog([template]);

    expect(result.providers).toEqual([
      {
        name: "opencode-zen",
        plugin: "openai-compatible",
        credentialName: "opencode-zen",
      },
    ]);
    expect(result.models).toEqual([
      { canonicalName: "deepseek-v4-flash", contextWindow: 128_000 },
    ]);
    expect(result.offerings).toEqual([
      { model: "deepseek-v4-flash", provider: "opencode-zen" },
    ]);
  });

  it("deduplicates providers and models across templates sharing the same credential", () => {
    const templates = [
      {
        key: "agent-a",
        credentialRequirements: [
          {
            source: "tenant",
            providerName: "openai-compatible",
            name: "opencode-zen",
          },
        ],
        modelConfig: { defaultModel: "deepseek-v4-flash" },
      },
      {
        key: "agent-b",
        credentialRequirements: [
          {
            source: "tenant",
            providerName: "openai-compatible",
            name: "opencode-zen",
          },
        ],
        modelConfig: { defaultModel: "deepseek-v4-flash" },
      },
    ];

    const result = buildAgentCatalog(templates);

    expect(result.providers.length).toBe(1);
    expect(result.models.length).toBe(1);
    expect(result.offerings.length).toBe(1);
  });

  it("throws when a template has no tenant inference credential", () => {
    const template = {
      key: "bad-agent",
      credentialRequirements: [],
      modelConfig: { defaultModel: "gpt-4o" },
    };

    expect(() => buildAgentCatalog([template])).toThrow(
      "has no tenant inference credential requirement",
    );
  });

  it("throws when a template has no modelConfig.defaultModel", () => {
    const template = {
      key: "no-model-agent",
      credentialRequirements: [
        {
          source: "tenant",
          providerName: "openai-compatible",
          name: "opencode-zen",
        },
      ],
      modelConfig: {},
    };

    expect(() => buildAgentCatalog([template])).toThrow(
      "must declare modelConfig.defaultModel",
    );
  });
});
