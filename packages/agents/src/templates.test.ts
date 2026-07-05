import { describe, expect, it } from "bun:test";
import { AGENT_TEMPLATES, isReapableChatAgent } from "./templates";

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
      "file-parser",
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

describe("isReapableChatAgent", () => {
  it("reaps ONLY the personal agent (the only one with an on-demand wake); never a shared agent", () => {
    // CL-2790: Myra (kind:"personal") wakes via POST /v1/me. Oat is a shared,
    // deployable chat agent but has NO wake trigger on its next message — a
    // slept Oat would 502 with no self-heal — so it must NOT be reaped until the
    // universal delivery-seam wake lands.
    const myra = AGENT_TEMPLATES.find((t) => t.key === "myra");
    const oat = AGENT_TEMPLATES.find((t) => t.key === "oat");
    expect(myra?.kind).toBe("personal");
    expect(oat).toBeDefined();
    expect(oat?.deployable).not.toBe(false);
    expect(isReapableChatAgent(myra!.name)).toBe(true);
    expect(isReapableChatAgent(oat!.name)).toBe(false);
  });

  it("never reaps the non-chat system agents (Loop, file-parser)", () => {
    const loop = AGENT_TEMPLATES.find((t) => t.key === "loop");
    const fileParser = AGENT_TEMPLATES.find((t) => t.key === "file-parser");
    expect(loop?.deployable).toBe(false);
    expect(fileParser?.deployable).toBe(false);
    expect(isReapableChatAgent(loop!.name)).toBe(false);
    expect(isReapableChatAgent(fileParser!.name)).toBe(false);
  });

  it("never reaps an unrecognized agent name", () => {
    expect(isReapableChatAgent("Some Unknown Agent")).toBe(false);
    expect(isReapableChatAgent("")).toBe(false);
  });
});
