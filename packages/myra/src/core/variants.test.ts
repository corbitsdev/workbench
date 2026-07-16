import { describe, expect, test } from "bun:test";
import {
  MYRA_VARIANTS,
  MyraVariantSummarySchema,
  defaultMyraVariant,
  getMyraVariant,
  isMyraVariantId,
  listMyraVariants,
  resolveMyraVariant,
} from "./variants";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
  PERSONAL_AGENT_DEPLOY_PROMPT,
  PERSONAL_AGENT_MODEL_CONFIG,
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_TRIAGE_MODEL_CONFIG,
  PERSONAL_AGENT_TRIAGE_NAME,
} from "./definition";
import { PERSONAL_AGENT_PROMPT_VERSION } from "./prompt";
import { MAILBOX_PERSONA_TOOLS } from "../personas/mailbox";

// A version-stable fragment of the single base prompt's role section. Present
// in every render regardless of xml/markdown format, so it proves a variant's
// prompt is derived from `buildPersonalAgentSystemPrompt`, not a fork.
const BASE_PROMPT_MARKER = "Chief of Staff to the one person you work for";

describe("Myra variant catalog", () => {
  test("every variant prompt derives from the single versioned base", () => {
    for (const variant of MYRA_VARIANTS) {
      expect(variant.deployPrompt).toContain(BASE_PROMPT_MARKER);
      expect(variant.versionId).toContain(PERSONAL_AGENT_PROMPT_VERSION);
    }
  });

  test("triage variants carry exactly the mailbox persona loadout", () => {
    const triage = MYRA_VARIANTS.filter((v) => v.kind === "triage");
    expect(triage.length).toBeGreaterThan(0);
    for (const variant of triage) {
      expect(variant.toolPolicy).toEqual(MAILBOX_PERSONA_TOOLS);
    }
  });

  test("chat variants carry the full base toolset", () => {
    for (const variant of MYRA_VARIANTS.filter((v) => v.kind === "chat")) {
      expect(variant.toolPolicy).toEqual(PERSONAL_AGENT_BASE_TOOLS);
    }
  });

  test("the default chat variant is byte-identical to today's Myra definition", () => {
    const variant = defaultMyraVariant("chat");
    expect(variant.id).toBe("myra-deepseek-v4-flash");
    expect(variant.model).toBe("deepseek-v4-flash");
    expect(variant.seedName).toBe(PERSONAL_AGENT_NAME);
    expect(variant.templateKey).toBe("myra");
    expect(variant.modelConfig).toEqual(PERSONAL_AGENT_MODEL_CONFIG);
    expect(variant.deployPrompt).toBe(PERSONAL_AGENT_DEPLOY_PROMPT);
    expect(variant.credentialRequirements).toEqual(
      PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
    );
    expect(variant.toolPolicy).toEqual(PERSONAL_AGENT_BASE_TOOLS);
  });

  test("the default triage variant is byte-identical to today's Myra Triage definition", () => {
    const variant = defaultMyraVariant("triage");
    expect(variant.seedName).toBe(PERSONAL_AGENT_TRIAGE_NAME);
    expect(variant.templateKey).toBe("myra-triage");
    expect(variant.modelConfig).toEqual(PERSONAL_AGENT_TRIAGE_MODEL_CONFIG);
  });

  test("the Opus variants declare a tenant anthropic credential and XML prompt", () => {
    for (const variant of MYRA_VARIANTS.filter(
      (v) => v.model === "claude-opus-4-8",
    )) {
      expect(variant.provider).toBe("anthropic");
      expect(variant.credentialRequirements).toEqual([
        { providerName: "anthropic", source: "tenant", name: "anthropic-api" },
      ]);
      expect(variant.promptFormat).toEqual({ xml: true });
    }
  });

  test("Opus variants report premium cost tier; the rest standard", () => {
    for (const variant of MYRA_VARIANTS) {
      const expected = variant.model === "claude-opus-4-8" ? "premium" : "standard";
      expect(variant.costTier).toBe(expected);
    }
  });

  test("non-anthropic variants keep the opencode-zen credential", () => {
    for (const variant of MYRA_VARIANTS.filter(
      (v) => v.provider === "openai-compatible",
    )) {
      expect(variant.credentialRequirements).toEqual(
        PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
      );
    }
  });

  test("variant ids and version ids are unique", () => {
    const ids = MYRA_VARIANTS.map((v) => v.id);
    const versionIds = MYRA_VARIANTS.map((v) => v.versionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(versionIds).size).toBe(versionIds.length);
  });

  test("seed names are unique so lazy binding resolves one definition each", () => {
    const seedNames = MYRA_VARIANTS.map((v) => v.seedName);
    expect(new Set(seedNames).size).toBe(seedNames.length);
  });

  test("exactly one default per kind", () => {
    expect(MYRA_VARIANTS.filter((v) => v.kind === "chat" && v.isDefault)).toHaveLength(1);
    expect(
      MYRA_VARIANTS.filter((v) => v.kind === "triage" && v.isDefault),
    ).toHaveLength(1);
  });

  test("all three requested models exist per kind", () => {
    const chatModels = new Set(
      MYRA_VARIANTS.filter((v) => v.kind === "chat").map((v) => v.model),
    );
    const triageModels = new Set(
      MYRA_VARIANTS.filter((v) => v.kind === "triage").map((v) => v.model),
    );
    const expected = new Set([
      "deepseek-v4-flash",
      "kimi-k2.6",
      "claude-opus-4-8",
    ]);
    expect(chatModels).toEqual(expected);
    expect(triageModels).toEqual(expected);
  });
});

describe("variant lookup helpers", () => {
  test("listMyraVariants returns the boundary summary for every variant", () => {
    const summaries = listMyraVariants();
    expect(summaries).toHaveLength(MYRA_VARIANTS.length);
    for (const summary of summaries) {
      expect(MyraVariantSummarySchema(summary)).toEqual(summary);
    }
  });

  test("getMyraVariant resolves a known id and rejects an unknown one", () => {
    expect(getMyraVariant("myra-opus-4-8")?.model).toBe("claude-opus-4-8");
    expect(getMyraVariant("nope")).toBeUndefined();
  });

  test("isMyraVariantId enforces kind when given", () => {
    expect(isMyraVariantId("myra-opus-4-8")).toBe(true);
    expect(isMyraVariantId("myra-opus-4-8", "chat")).toBe(true);
    expect(isMyraVariantId("myra-opus-4-8", "triage")).toBe(false);
    expect(isMyraVariantId("nope")).toBe(false);
  });

  test("resolveMyraVariant honors a valid selection", () => {
    expect(resolveMyraVariant("chat", "myra-opus-4-8").id).toBe("myra-opus-4-8");
    expect(resolveMyraVariant("triage", "myra-triage-kimi-k2-6").id).toBe(
      "myra-triage-kimi-k2-6",
    );
  });

  test("resolveMyraVariant falls back to the default on null/unknown/wrong-kind", () => {
    expect(resolveMyraVariant("chat", null).id).toBe(defaultMyraVariant("chat").id);
    expect(resolveMyraVariant("chat", undefined).id).toBe(
      defaultMyraVariant("chat").id,
    );
    expect(resolveMyraVariant("chat", "nope").id).toBe(
      defaultMyraVariant("chat").id,
    );
    // A triage id requested for the chat kind must not bind — fall back.
    expect(resolveMyraVariant("chat", "myra-triage-opus-4-8").id).toBe(
      defaultMyraVariant("chat").id,
    );
  });
});
