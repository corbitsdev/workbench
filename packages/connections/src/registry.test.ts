import { describe, expect, test } from "bun:test";
import { CONNECTOR_REGISTRY, connectorDescriptors } from "./registry";

describe("CONNECTOR_REGISTRY", () => {
  test("every entry has an id, displayName, docsUrl, api-key auth kind, and a probe", () => {
    for (const descriptor of Object.values(CONNECTOR_REGISTRY)) {
      expect(descriptor.id.length).toBeGreaterThan(0);
      expect(descriptor.displayName.length).toBeGreaterThan(0);
      expect(descriptor.docsUrl.length).toBeGreaterThan(0);
      expect(descriptor.authKind).toBe("api-key");
      expect(descriptor.probe).toBeDefined();
    }
  });

  test("excludes the OAuth inference providers", () => {
    expect(CONNECTOR_REGISTRY["openrouter"]).toBeUndefined();
    expect(CONNECTOR_REGISTRY["huggingface"]).toBeUndefined();
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

  test("includes the five tool connectors with the right feedsTools", () => {
    expect(CONNECTOR_REGISTRY["granola"]?.feedsTools).toEqual([
      "@corbits/granola-tools",
    ]);
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
    expect(CONNECTOR_REGISTRY["exa"]?.credentialPlugin).toBe(
      "http-x-api-key",
    );
    expect(CONNECTOR_REGISTRY["scrapecreators"]?.credentialPlugin).toBe(
      "http-x-api-key",
    );
    const bearerConnectors = new Set([
      "linear",
      "exa",
      "scrapecreators",
    ]);
    for (const [id, descriptor] of Object.entries(CONNECTOR_REGISTRY)) {
      if (bearerConnectors.has(id)) continue;
      expect(descriptor.credentialPlugin).toBe("http");
    }
  });
});
