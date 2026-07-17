import { describe, expect, test } from "bun:test";
import {
  AGENT_CATALOG,
  buildAgentCatalog,
  templateModelName,
  templateModelRequirements,
} from "./catalog";
import { AGENT_TEMPLATES } from "./templates";

describe("templateModelRequirements", () => {
  test("derives a single requirement from the template model", () => {
    const template = AGENT_TEMPLATES.find((t) => t.key === "myra");
    if (!template) throw new Error("myra template missing");
    expect(templateModelRequirements(template)).toEqual([
      { model: templateModelName(template) },
    ]);
  });

  test("throws when a template declares no model", () => {
    expect(() =>
      templateModelName({
        key: "x",
        name: "X",
        description: "",
        systemPrompt: "",
        credentialRequirements: [],
        grantRequirements: [],
        capabilities: { tools: [] },
      }),
    ).toThrow(/modelConfig.defaultModel/);
  });
});

describe("AGENT_CATALOG coverage", () => {
  test("every agent model has a catalog model entry", () => {
    const models = new Set(AGENT_CATALOG.models.map((m) => m.canonicalName));
    for (const template of AGENT_TEMPLATES) {
      expect(models).toContain(templateModelName(template));
    }
  });

  test("every agent inference provider has a catalog provider entry", () => {
    const providers = new Set(AGENT_CATALOG.providers.map((p) => p.name));
    for (const template of AGENT_TEMPLATES) {
      const req = template.credentialRequirements.find(
        (r) => r.source === "tenant",
      );
      if (!req?.name)
        throw new Error(`template ${template.key} has no tenant credential`);
      expect(providers).toContain(req.name);
    }
  });

  test("every agent has an offering pairing its model and provider", () => {
    const pairs = new Set(
      AGENT_CATALOG.offerings.map((o) => `${o.model} ${o.provider}`),
    );
    for (const template of AGENT_TEMPLATES) {
      const req = template.credentialRequirements.find(
        (r) => r.source === "tenant",
      );
      if (!req?.name)
        throw new Error(`template ${template.key} has no tenant credential`);
      expect(pairs).toContain(`${templateModelName(template)} ${req.name}`);
    }
  });

  test("the expected provider/model matrix is present and de-duplicated", () => {
    expect(new Set(AGENT_CATALOG.providers.map((p) => p.name))).toEqual(
      new Set(["opencode-zen", "anthropic-api"]),
    );
    expect(new Set(AGENT_CATALOG.models.map((m) => m.canonicalName))).toEqual(
      new Set([
        "deepseek-v4-flash",
        "kimi-k2.6",
        "kimi-k3",
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
      ]),
    );
    const openai = AGENT_CATALOG.providers.find(
      (p) => p.name === "opencode-zen",
    );
    expect(openai?.plugin).toBe("openai-compatible");
    const anthropic = AGENT_CATALOG.providers.find(
      (p) => p.name === "anthropic-api",
    );
    expect(anthropic?.plugin).toBe("anthropic");
  });

  test("each template declares exactly one tenant inference credential", () => {
    // The derivation (inferenceCredential) and these coverage tests both assume
    // a single source:'tenant' credential per agent — the inference one. Assert
    // it so a future tool credential mistakenly added with source:'tenant'
    // (which belongs on credentialProviderNames) fails here, not silently.
    for (const template of AGENT_TEMPLATES) {
      const tenantCreds = template.credentialRequirements.filter(
        (r) => r.source === "tenant",
      );
      expect(tenantCreds).toHaveLength(1);
    }
  });

  test("buildAgentCatalog de-dupes providers, models, and offerings", () => {
    const t = AGENT_TEMPLATES.find((x) => x.key === "myra");
    if (!t) throw new Error("myra missing");
    const built = buildAgentCatalog([t, t]);
    expect(built.providers).toHaveLength(1);
    expect(built.models).toHaveLength(1);
    expect(built.offerings).toHaveLength(1);
  });
});
