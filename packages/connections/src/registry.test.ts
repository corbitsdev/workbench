import { describe, expect, test } from "bun:test";
import { CONNECTOR_REGISTRY, connectorDescriptors } from "./registry";

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
    expect(connectorDescriptors().length).toBe(
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
