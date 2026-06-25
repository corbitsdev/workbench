import { describe, expect, it } from "bun:test";
import { AGENT_TEMPLATES } from "./templates";

describe("AGENT_TEMPLATES", () => {
  const inferenceProviderNames = new Set(["anthropic", "openai-compatible"]);
  const knownToolProviderNames = new Set([
    "exa",
    "firecrawl",
    "granola",
    "reddit",
    "scrapecreators",
    "xai",
  ]);

  it("contains all seeded templates", () => {
    const keys = AGENT_TEMPLATES.map((t) => t.key).sort();
    expect(keys).toEqual([
      "fannie",
      "freddie",
      "freddy",
      "hammy",
      "lincoln",
      "loop",
      "myra",
      "oat",
      "walter",
    ]);
  });

  it("registers Freddie as deployable Opus-backed Fable prompt agent", () => {
    const freddie = AGENT_TEMPLATES.find((t) => t.key === "freddie");
    expect(freddie).toBeDefined();
    expect(freddie?.name).toBe("Freddie");
    expect(freddie?.modelConfig).toEqual({ defaultModel: "claude-opus-4-8" });
    expect(freddie?.capabilities.tools).not.toContain("mail_send");
    expect(freddie?.capabilities.tools).not.toContain("mail_reply");
  });

  it("every template has a non-empty name, systemPrompt, and credentialRequirements", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.systemPrompt.length).toBeGreaterThan(0);
      expect(template.credentialRequirements.length).toBeGreaterThan(0);
      expect(Array.isArray(template.capabilities.tools)).toBe(true);
    }
  });

  it("only declares inference providers as launch-time credential requirements", () => {
    for (const template of AGENT_TEMPLATES) {
      for (const requirement of template.credentialRequirements) {
        expect(inferenceProviderNames.has(requirement.providerName)).toBe(true);
        expect(knownToolProviderNames.has(requirement.providerName)).toBe(
          false,
        );
      }
    }
  });

  it("does not bake dynamic per-workbench grants into any template", () => {
    for (const template of AGENT_TEMPLATES) {
      for (const grant of template.grantRequirements) {
        expect(grant.resource.startsWith("tenant:")).toBe(false);
      }
    }
  });

  it("no template has any mail tools", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.capabilities.tools).not.toContain("mail_send");
      expect(template.capabilities.tools).not.toContain("mail_reply");
      expect(template.capabilities.tools).not.toContain("mail_search");
      expect(template.capabilities.tools).not.toContain("mail_read");
    }
  });

  it("no template has any mail grants", () => {
    for (const template of AGENT_TEMPLATES) {
      for (const grant of template.grantRequirements) {
        expect(grant.resource.startsWith("tool:mail")).toBe(false);
      }
    }
  });
});
