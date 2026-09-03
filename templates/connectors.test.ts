import { describe, expect, test } from "bun:test";
import { connectorDescriptors } from "@corbits/connections/registry";
import {
  mcpPresetByName,
  mcpPresetBySlug,
} from "@corbits/connections/mcp-presets";
import {
  CONNECTOR_REGISTRY,
  MCP_PRESET_CONNECTOR_IDS,
  MCP_PRESETS,
} from "./connectors";

describe("CONNECTOR_REGISTRY", () => {
  test("every entry has an id, displayName, and docsUrl", () => {
    for (const descriptor of Object.values(CONNECTOR_REGISTRY)) {
      expect(descriptor.id.length).toBeGreaterThan(0);
      expect(descriptor.displayName.length).toBeGreaterThan(0);
      expect(descriptor.docsUrl.length).toBeGreaterThan(0);
    }
  });

  test("every api-key entry has a probe", () => {
    for (const descriptor of Object.values(CONNECTOR_REGISTRY)) {
      if (descriptor.authKind !== "api-key") continue;
      expect(descriptor.probe).toBeDefined();
    }
  });

  // `github` is the one deliberate exception (CL-6386): it stays
  // `authKind: "api-key"` (the PAT paste form is always available) but
  // also carries an `oauth` config a caller checks `GET
  // /oauth-configured` before offering, ahead of the paste form, as a
  // hosted one-click connect. Every other api-key connector still names
  // no `oauth` at all.
  test("only github carries an oauth config alongside api-key", () => {
    for (const descriptor of Object.values(CONNECTOR_REGISTRY)) {
      if (descriptor.authKind !== "api-key") continue;
      if (descriptor.id === "github") {
        expect(descriptor.oauth).toBeDefined();
        continue;
      }
      expect(descriptor.oauth).toBeUndefined();
    }
  });

  // CL-6258: every provider row in Settings > Connections needs a logo
  // tile -- a simple-icons mark where one exists, a monochrome initial
  // tile (rendered from `displayName` alone) where it doesn't.
  test("every inference provider with a simple-icons listing carries a hex-keyed icon", () => {
    for (const id of [
      "anthropic",
      "google-genai",
      "deepseek",
      "mistral",
      "ollama",
      "openrouter",
      "huggingface",
    ]) {
      const descriptor = CONNECTOR_REGISTRY[id];
      expect(descriptor?.icon?.path.length).toBeGreaterThan(0);
      expect(descriptor?.icon?.hex).toMatch(/^[0-9A-F]{6}$/i);
    }
  });

  test("providers with no simple-icons listing fall back to no icon (initial tile)", () => {
    for (const id of ["openai", "xai", "groq", "opencode-zen"]) {
      expect(CONNECTOR_REGISTRY[id]?.icon).toBeUndefined();
    }
  });

  test("includes OpenRouter and Hugging Face as oauth-pkce connectors, no probe", () => {
    for (const id of ["openrouter", "huggingface"]) {
      const descriptor = CONNECTOR_REGISTRY[id];
      expect(descriptor?.authKind).toBe("oauth-pkce");
      expect(descriptor?.probe).toBeUndefined();
      expect(descriptor?.oauth).toBeDefined();
      expect(descriptor?.oauth?.usesPKCE).toBe(true);
      expect(descriptor?.oauth?.deploysDefaultWorkflows).toBe(true);
      expect(descriptor?.feedsTools).toEqual([]);
    }
  });

  test("only Hugging Face requires a configured client id", () => {
    expect(CONNECTOR_REGISTRY["openrouter"]?.oauth?.clientId).toBeUndefined();
    expect(
      CONNECTOR_REGISTRY["huggingface"]?.oauth?.clientId?.({}),
    ).toBeUndefined();
    expect(
      CONNECTOR_REGISTRY["huggingface"]?.oauth?.clientId?.({
        huggingfaceClientId: "hf_1",
      }),
    ).toBe("hf_1");
  });

  test("only Hugging Face echoes state back in its callback query", () => {
    expect(CONNECTOR_REGISTRY["openrouter"]?.oauth?.echoesState).toBe(false);
    expect(CONNECTOR_REGISTRY["huggingface"]?.oauth?.echoesState).toBe(true);
  });

  test("includes the eight non-OAuth inference providers", () => {
    for (const id of [
      "anthropic",
      "openai",
      "google-genai",
      "xai",
      "opencode-zen",
      "groq",
      "deepseek",
      "mistral",
    ]) {
      expect(CONNECTOR_REGISTRY[id]).toBeDefined();
      expect(CONNECTOR_REGISTRY[id]?.feedsTools).toEqual([]);
    }
  });

  test("ollama collects a URL, not a key, and needs no probed secret to reach reachability", () => {
    const descriptor = CONNECTOR_REGISTRY["ollama"];
    expect(descriptor?.authKind).toBe("api-key");
    expect(descriptor?.credentialInputKind).toBe("url");
    expect(descriptor?.credentialPlaceholder).toBe("http://localhost:11434");
    expect(descriptor?.probe).toBeDefined();
    expect(descriptor?.feedsTools).toEqual([]);
  });

  test("includes the tool connectors with the right feedsTools", () => {
    expect(CONNECTOR_REGISTRY["granola"]?.feedsTools).toEqual([
      "@corbits/granola-tools",
    ]);
    expect(CONNECTOR_REGISTRY["manus"]?.feedsTools).toEqual([
      "@corbits/manus-tools",
    ]);
    expect(CONNECTOR_REGISTRY["manus"]?.credentialPlugin).toBe(
      "http-x-manus-api-key",
    );
    expect(CONNECTOR_REGISTRY["manus"]?.authKind).toBe("api-key");
    expect(CONNECTOR_REGISTRY["manus"]?.icon).toBeUndefined();
    expect(CONNECTOR_REGISTRY["exa"]?.feedsTools).toEqual([
      "@corbits/web-search-tools",
    ]);
    expect(CONNECTOR_REGISTRY["scrapecreators"]?.feedsTools).toEqual([
      "@corbits/reddit-tools",
    ]);
    expect(CONNECTOR_REGISTRY["scrapecreators"]?.displayName).toBe(
      "ScrapeCreators",
    );
    expect(CONNECTOR_REGISTRY["linear"]?.feedsTools).toEqual([
      "@corbits/linear-tools",
    ]);
    expect(CONNECTOR_REGISTRY["github"]?.feedsTools).toEqual([
      "@corbits/github-tools",
    ]);
  });
});

describe("granola-webhook", () => {
  test("is a webhook-secret connector with no probe, no oauth, and no feedsTools", () => {
    const descriptor = CONNECTOR_REGISTRY["granola-webhook"];
    expect(descriptor?.authKind).toBe("webhook-secret");
    expect(descriptor?.probe).toBeUndefined();
    expect(descriptor?.oauth).toBeUndefined();
    expect(descriptor?.feedsTools).toEqual([]);
    expect(descriptor?.credentialPlugin).toBe("http");
  });
});

describe("connectorDescriptors", () => {
  test("returns every registry entry", () => {
    expect(connectorDescriptors(CONNECTOR_REGISTRY).length).toBe(
      Object.keys(CONNECTOR_REGISTRY).length,
    );
  });

  test("each connector mediates through the header plugin its API actually expects", () => {
    expect(CONNECTOR_REGISTRY["linear"]?.credentialPlugin).toBe(
      "http-raw-authorization",
    );
    expect(CONNECTOR_REGISTRY["exa"]?.credentialPlugin).toBe("http-x-api-key");
    expect(CONNECTOR_REGISTRY["scrapecreators"]?.credentialPlugin).toBe(
      "http-x-api-key",
    );
    expect(CONNECTOR_REGISTRY["manus"]?.credentialPlugin).toBe(
      "http-x-manus-api-key",
    );
    const nonBearer = new Set(["linear", "exa", "scrapecreators", "manus"]);
    for (const [id, descriptor] of Object.entries(CONNECTOR_REGISTRY)) {
      if (nonBearer.has(id)) continue;
      expect(descriptor.credentialPlugin).toBe("http");
    }
  });
});

describe("gmail connector", () => {
  test("is a pure oauth-code connector with a hosted-app env pair", () => {
    const descriptor = CONNECTOR_REGISTRY["gmail"];
    expect(descriptor?.authKind).toBe("oauth-code");
    expect(descriptor?.credentialPlugin).toBe("http");
    expect(descriptor?.oauth).toBeDefined();
    expect(descriptor?.oauth?.clientId?.({ gmailClientId: "client-1" })).toBe(
      "client-1",
    );
    expect(
      descriptor?.oauth?.clientSecret?.({ gmailClientSecret: "secret-1" }),
    ).toBe("secret-1");
    expect(descriptor?.oauth?.clientId?.({})).toBeUndefined();
  });

  test("asks Google for offline access and the gmail scope with PKCE", () => {
    const descriptor = CONNECTOR_REGISTRY["gmail"];
    const url = descriptor?.oauth?.buildAuthorizeUrl({
      callbackUrl: "https://bench.example.com/callback",
      state: "state-1",
      codeChallenge: "challenge-1",
      clientId: "client-1",
    });
    if (url === undefined) throw new Error("no authorize url");
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://bench.example.com/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("gmail");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

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
    expect(mcpPresetBySlug(MCP_PRESETS, "exa")?.connectionMode).toBe("keyless");
    expect(mcpPresetBySlug(MCP_PRESETS, "github-mcp")?.connectionMode).toBe(
      "token",
    );
    for (const preset of MCP_PRESETS) {
      if (preset.slug === "exa" || preset.slug === "github-mcp") continue;
      expect(preset.connectionMode).toBe("oauth");
    }
  });

  test("GitHub MCP is a token preset that never shadows the github connector", () => {
    const preset = mcpPresetBySlug(MCP_PRESETS, "github-mcp");
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
    expect(mcpPresetByName(MCP_PRESETS, "github")).toBeUndefined();
    expect(mcpPresetByName(MCP_PRESETS, "GitHub")).toBeUndefined();
    expect(mcpPresetByName(MCP_PRESETS, "github mcp")?.slug).toBe("github-mcp");
  });

  test("uses Sumble's OAuth MCP host, not its product-page URL", () => {
    expect(mcpPresetBySlug(MCP_PRESETS, "sumble")?.url).toBe(
      "https://mcp.sumble.com/",
    );
    expect(mcpPresetBySlug(MCP_PRESETS, "sumble")?.connectionMode).toBe(
      "oauth",
    );
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
    expect(mcpPresetByName(MCP_PRESETS, "Exa")?.slug).toBe("exa");
    expect(mcpPresetByName(MCP_PRESETS, "EXA")?.slug).toBe("exa");
    expect(mcpPresetByName(MCP_PRESETS, "granola")?.slug).toBe("granola");
    expect(mcpPresetByName(MCP_PRESETS, "nope")).toBeUndefined();
  });

  test("mcpPresetBySlug returns undefined for an unknown slug", () => {
    expect(mcpPresetBySlug(MCP_PRESETS, "not-a-preset")).toBeUndefined();
  });

  test("Canva is a DCR-verified OAuth preset with no simple-icons mark yet", () => {
    expect(mcpPresetBySlug(MCP_PRESETS, "canva")?.connectionMode).toBe("oauth");
    expect(mcpPresetBySlug(MCP_PRESETS, "canva")?.icon).toBeUndefined();
  });

  test("Canva lists the 16 live PRM OAuth scopes; other presets omit oauthScopes", () => {
    expect(mcpPresetBySlug(MCP_PRESETS, "canva")?.oauthScopes).toEqual([
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
