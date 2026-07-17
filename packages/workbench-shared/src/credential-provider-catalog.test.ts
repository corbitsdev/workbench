import { describe, expect, it } from "bun:test";
import { CREDENTIAL_PROVIDER_CATALOG } from "./credential-provider-catalog";

describe("OpenRouter inference credential", () => {
  it("is an Owner-settable openai-compatible inference provider with the OpenRouter base URL", () => {
    const entry = CREDENTIAL_PROVIDER_CATALOG.find(
      (e) => e.providerName === "openrouter",
    );
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("inference");
    expect(entry?.providerPlugin).toBe("openai-compatible");
    expect(entry?.defaultMetadata?.["baseURL"]).toBe(
      "https://openrouter.ai/api/v1",
    );
  });
});
