import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";
import { composeMyraStyleOverlaySectionForInstance } from "./myra-style-overlay";

function makeDb(opts: {
  mapping?: { templateKey: string; memberPrincipalId: string };
  preferenceRow?: Record<string, string | null>;
}): HubDb {
  return {
    query: {
      memberAgentInstance: {
        findFirst: mock(async () => opts.mapping),
      },
      myraVariantPreference: {
        findFirst: mock(async () => opts.preferenceRow),
      },
    },
  } as unknown as HubDb;
}

describe("composeMyraStyleOverlaySectionForInstance", () => {
  it("returns null when the instance has no member mapping", async () => {
    const db = makeDb({});
    const result = await composeMyraStyleOverlaySectionForInstance(db, {
      tenantId: "tn",
      instanceId: "inst_1",
      provider: "openai-compatible",
    });
    expect(result).toBeNull();
  });

  it("returns null for a non-Myra template (byte-identical prompt)", async () => {
    const db = makeDb({
      mapping: { templateKey: "oat", memberPrincipalId: "prn" },
    });
    const result = await composeMyraStyleOverlaySectionForInstance(db, {
      tenantId: "tn",
      instanceId: "inst_1",
      provider: "openai-compatible",
    });
    expect(result).toBeNull();
  });

  it("returns null for a Myra chat instance with no stored style selection", async () => {
    const db = makeDb({
      mapping: { templateKey: "myra", memberPrincipalId: "prn" },
    });
    const result = await composeMyraStyleOverlaySectionForInstance(db, {
      tenantId: "tn",
      instanceId: "inst_1",
      provider: "openai-compatible",
    });
    expect(result).toBeNull();
  });

  it("composes a markdown section for a Myra chat instance's non-default selection", async () => {
    const db = makeDb({
      mapping: { templateKey: "myra", memberPrincipalId: "prn" },
      preferenceRow: {
        chatVariantId: null,
        triageVariantId: null,
        personality: "candid",
        artifactUsageChat: "none",
        artifactUsageTriage: "heavy",
      },
    });
    const result = await composeMyraStyleOverlaySectionForInstance(db, {
      tenantId: "tn",
      instanceId: "inst_1",
      provider: "openai-compatible",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("## Personalization-style");
    expect(result).toContain(
      "Be blunt and direct — say the hard thing plainly, skip diplomatic softening.",
    );
    expect(result).toContain(
      "Do not create artifacts; deliver results in the reply.",
    );
    // The triage-only artifactUsageTriage selection must not leak into chat.
    expect(result).not.toContain(
      "Create an artifact for any substantial output",
    );
  });

  it("composes an xml section for a Myra triage instance on the anthropic provider, using the triage usage axis", async () => {
    const db = makeDb({
      mapping: { templateKey: "myra-triage", memberPrincipalId: "prn" },
      preferenceRow: {
        chatVariantId: null,
        triageVariantId: null,
        artifactUsageChat: "none",
        artifactUsageTriage: "heavy",
      },
    });
    const result = await composeMyraStyleOverlaySectionForInstance(db, {
      tenantId: "tn",
      instanceId: "inst_1",
      provider: "anthropic",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("<personalization-style>");
    expect(result).toContain("Create an artifact for any substantial output");
    expect(result).not.toContain(
      "Do not create artifacts; deliver results in the reply.",
    );
  });

  it("resolves a Myra chat variant template key (non-canonical) as the chat surface", async () => {
    const db = makeDb({
      mapping: { templateKey: "myra-chat-opus-4-8", memberPrincipalId: "prn" },
      preferenceRow: { emojiUse: "heavy" },
    });
    const result = await composeMyraStyleOverlaySectionForInstance(db, {
      tenantId: "tn",
      instanceId: "inst_1",
      provider: "openai-compatible",
    });
    expect(result).toContain(
      "Use emoji freely to add tone and visual texture to your replies.",
    );
  });
});
