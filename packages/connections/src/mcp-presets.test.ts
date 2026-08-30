import { describe, expect, test } from "bun:test";
import {
  MCP_PRESET_CONNECTOR_IDS,
  MCP_PRESETS,
  mcpPresetByName,
  mcpPresetBySlug,
} from "./mcp-presets";
import { CONNECTOR_REGISTRY } from "./registry";

describe("MCP_PRESETS", () => {
  test("lists only verified zero-configuration remote MCP servers", () => {
    const slugs = MCP_PRESETS.map((preset) => preset.slug).sort();
    expect(slugs).toEqual(
      [
        "attio",
        "canva",
        "exa",
        "github-mcp",
        "granola",
        "linear",
        "notion",
        "posthog",
        "railway",
        "sentry",
        "sumble",
      ].sort(),
    );
    for (const preset of MCP_PRESETS) {
      expect(() => new URL(preset.url)).not.toThrow();
      expect(preset.url.startsWith("https://")).toBe(true);
    }
  });

  test("Exa is keyless, GitHub MCP is token, every other preset uses OAuth", () => {
    expect(mcpPresetBySlug("exa")?.connectionMode).toBe("keyless");
    expect(mcpPresetBySlug("github-mcp")?.connectionMode).toBe("token");
    for (const preset of MCP_PRESETS) {
      if (preset.slug === "exa" || preset.slug === "github-mcp") continue;
      expect(preset.connectionMode).toBe("oauth");
    }
  });

  test("GitHub MCP is a token preset that never shadows the github connector", () => {
    const preset = mcpPresetBySlug("github-mcp");
    expect(preset?.displayName).toBe("GitHub MCP");
    expect(preset?.url).toBe("https://api.githubcopilot.com/mcp/");
    // GitHub's MCP server accepts a personal access token as a bearer but
    // offers no dynamic client registration, so OAuth can't complete here.
    expect(preset?.connectionMode).toBe("token");
    expect(preset?.docsUrl).toBe("https://github.com/settings/tokens");
    expect(preset?.tokenSteps?.length).toBeGreaterThanOrEqual(2);
    // The native `github` REST connector (PAT/OAuth-App) stays its own
    // card: no nativeConnectorId hides it, and neither "github" the slug
    // nor "GitHub" the display name resolves to this preset.
    expect(preset?.nativeConnectorId).toBeUndefined();
    expect(CONNECTOR_REGISTRY["github"]).toBeDefined();
    expect(mcpPresetByName("github")).toBeUndefined();
    expect(mcpPresetByName("GitHub")).toBeUndefined();
    expect(mcpPresetByName("github mcp")?.slug).toBe("github-mcp");
  });

  test("uses Sumble's OAuth MCP host, not its product-page URL", () => {
    expect(mcpPresetBySlug("sumble")?.url).toBe("https://mcp.sumble.com/");
    expect(mcpPresetBySlug("sumble")?.connectionMode).toBe("oauth");
  });

  test("keeps every verified endpoint exact", () => {
    expect(
      Object.fromEntries(
        MCP_PRESETS.map((preset) => [preset.slug, preset.url]),
      ),
    ).toEqual({
      granola: "https://mcp.granola.ai/mcp",
      exa: "https://mcp.exa.ai/mcp",
      "github-mcp": "https://api.githubcopilot.com/mcp/",
      linear: "https://mcp.linear.app/mcp",
      notion: "https://mcp.notion.com/mcp",
      sentry: "https://mcp.sentry.dev/mcp",
      attio: "https://mcp.attio.com/mcp",
      railway: "https://mcp.railway.com",
      posthog: "https://mcp.posthog.com/mcp",
      sumble: "https://mcp.sumble.com/",
      canva: "https://mcp.canva.com/mcp",
    });
  });

  test("every preset's nativeConnectorId names a real registry entry", () => {
    for (const preset of MCP_PRESETS) {
      if (preset.nativeConnectorId === undefined) continue;
      expect(CONNECTOR_REGISTRY[preset.nativeConnectorId]).toBeDefined();
    }
  });

  test("MCP_PRESET_CONNECTOR_IDS matches the presets' native ids", () => {
    expect(new Set(MCP_PRESET_CONNECTOR_IDS)).toEqual(
      new Set(["granola", "exa", "linear"]),
    );
  });

  test("mcpPresetByName resolves by slug or display name, case-insensitively", () => {
    expect(mcpPresetByName("Exa")?.slug).toBe("exa");
    expect(mcpPresetByName("EXA")?.slug).toBe("exa");
    expect(mcpPresetByName("granola")?.slug).toBe("granola");
    expect(mcpPresetByName("nope")).toBeUndefined();
  });

  test("mcpPresetBySlug returns undefined for an unknown slug", () => {
    expect(mcpPresetBySlug("not-a-preset")).toBeUndefined();
  });

  test("Canva is a DCR-verified OAuth preset with no simple-icons mark yet", () => {
    expect(mcpPresetBySlug("canva")?.connectionMode).toBe("oauth");
    expect(mcpPresetBySlug("canva")?.icon).toBeUndefined();
  });

  test("Canva lists the 16 live PRM OAuth scopes; other presets omit oauthScopes", () => {
    expect(mcpPresetBySlug("canva")?.oauthScopes).toEqual([
      "profile:read",
      "design:meta:read",
      "design:content:write",
      "design:content:read",
      "folder:read",
      "folder:write",
      "brandtemplate:content:read",
      "brandtemplate:meta:read",
      "brandtemplate:content:write",
      "comment:write",
      "comment:read",
      "asset:read",
      "asset:write",
      "brandkit:read",
      "help:answers:read",
      "help:answers:write",
    ]);
    for (const preset of MCP_PRESETS) {
      if (preset.slug === "canva") continue;
      expect("oauthScopes" in preset).toBe(false);
    }
  });
});
