import { describe, expect, it } from "bun:test";
import { AGENT_TEMPLATES, isReapableAgentInstance } from "./templates";

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
      "myra-chat-deepseek-v4-flash",
      "myra-chat-kimi-k3",
      "myra-chat-opus-4-8",
      "myra-triage",
      "myra-triage-kimi-k2-6",
      "myra-triage-opus-4-8",
      "oat",
      "walter",
    ]);
  });

  it("registers the canonical Myra chat template on kimi-k2.6", () => {
    const myra = AGENT_TEMPLATES.find((t) => t.key === "myra");
    expect(myra?.modelConfig).toEqual({ defaultModel: "kimi-k2.6" });
  });

  it("registers the Myra Triage variant on the flash model, not deployed to the catalog", () => {
    const triage = AGENT_TEMPLATES.find((t) => t.key === "myra-triage");
    const myra = AGENT_TEMPLATES.find((t) => t.key === "myra");
    expect(triage).toBeDefined();
    expect(triage?.name).toBe("Myra Triage");
    expect(triage?.modelConfig).toEqual({ defaultModel: "deepseek-v4-flash" });
    expect(triage?.deployable).toBe(false);
    // Grants stay the full Myra base toolset — only the mailbox persona's
    // advertised loadout narrows at launch (packages/myra/src/personas/mailbox.ts).
    expect(triage?.capabilities.tools).toEqual(myra?.capabilities.tools);
  });

  it("registers Freddie as deployable Opus-backed Fable prompt agent", () => {
    const freddie = AGENT_TEMPLATES.find((t) => t.key === "freddie");
    expect(freddie).toBeDefined();
    expect(freddie?.name).toBe("Freddie");
    expect(freddie?.modelConfig).toEqual({ defaultModel: "claude-opus-4-8" });
    expect(freddie?.capabilities.tools).not.toContain("mail_send");
    expect(freddie?.capabilities.tools).not.toContain("mail_reply");
  });

  // The hub resolves a deployed instance's agent definition by walking the
  // tenant hierarchy for `agent.name === template.name` (apps/hub/src/routes/agents.ts,
  // findDefInHierarchy), and the /agents page joins a deployed instance back
  // to its definition card by the same `name` key. Both would silently
  // mismatch if two templates ever shared a name.
  it("has a unique name per template", () => {
    const names = AGENT_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
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

  // CL-3407: Myra (chat and triage, which seed the same capabilities.tools —
  // see the equality assertion above) carries mail_send so she can send a
  // note to a teammate's mailbox. Every other template, and every other mail
  // tool on Myra herself, stays out.
  it("no template has any mail tool except Myra's mail_send", () => {
    for (const template of AGENT_TEMPLATES) {
      // Every Myra variant (canonical `myra`/`myra-triage` and the generated
      // per-model chat/triage definitions) seeds the full Myra base toolset,
      // which includes mail_send; no other agent does.
      const expectsMailSend =
        template.key === "myra" || template.key.startsWith("myra-");
      expect(template.capabilities.tools.includes("mail_send")).toBe(
        expectsMailSend,
      );
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

describe("isReapableAgentInstance", () => {
  it("reaps the personal agent AND a shared agent — reaping is universal over kind", () => {
    // The reaper is universal now: template `kind` (or lack of it)
    // no longer gates reapability. Myra wakes via the chat-surface sessions
    // route; Oat now wakes via the mail-route relaunch (relaunchInstanceIfNeeded)
    // ahead of interchange's mail-send route.
    const myra = AGENT_TEMPLATES.find((t) => t.key === "myra");
    const oat = AGENT_TEMPLATES.find((t) => t.key === "oat");
    expect(myra?.kind).toBe("personal");
    expect(oat).toBeDefined();
    expect(oat?.deployable).not.toBe(false);
    expect(isReapableAgentInstance(myra!.name)).toBe(true);
    expect(isReapableAgentInstance(oat!.name)).toBe(true);
  });

  it("never reaps a self-driven agent (Loop) — its interval schedule has no mail to wake it", () => {
    const loop = AGENT_TEMPLATES.find((t) => t.key === "loop");
    expect(loop?.selfDriven).toBe(true);
    expect(isReapableAgentInstance(loop!.name)).toBe(false);
  });

  it("reaps other non-personal shared agents (Walter) — kind does not matter", () => {
    const walter = AGENT_TEMPLATES.find((t) => t.key === "walter");
    expect(walter).toBeDefined();
    expect(walter?.kind).toBeUndefined();
    expect(isReapableAgentInstance(walter!.name)).toBe(true);
  });

  it("never reaps the ephemeral single-purpose file-parser invocation", () => {
    const fileParser = AGENT_TEMPLATES.find((t) => t.key === "file-parser");
    expect(fileParser?.ephemeral).toBe(true);
    expect(isReapableAgentInstance(fileParser!.name)).toBe(false);
  });

  it("never reaps an unrecognized agent name", () => {
    expect(isReapableAgentInstance("Some Unknown Agent")).toBe(false);
    expect(isReapableAgentInstance("")).toBe(false);
  });

  it("reaps a non-canonical Myra chat variant exactly like the canonical agent", () => {
    const variantChat = AGENT_TEMPLATES.find(
      (t) => t.key === "myra-chat-deepseek-v4-flash",
    );
    const myra = AGENT_TEMPLATES.find((t) => t.key === "myra");
    expect(variantChat).toBeDefined();
    expect(variantChat?.kind).toBe("personal");
    expect(variantChat?.kind).toBe(myra?.kind);
    expect(isReapableAgentInstance(variantChat!.name)).toBe(true);
  });

  it("does not reap a Myra triage variant — ephemeral, never a chat surface", () => {
    const variantTriage = AGENT_TEMPLATES.find(
      (t) => t.key === "myra-triage-kimi-k2-6",
    );
    expect(variantTriage).toBeDefined();
    expect(variantTriage?.kind).toBeUndefined();
    expect(variantTriage?.ephemeral).toBe(true);
    expect(isReapableAgentInstance(variantTriage!.name)).toBe(false);
  });

  it("does not reap the canonical Myra Triage template — ephemeral", () => {
    const triage = AGENT_TEMPLATES.find((t) => t.key === "myra-triage");
    expect(triage?.ephemeral).toBe(true);
    expect(isReapableAgentInstance(triage!.name)).toBe(false);
  });
});
