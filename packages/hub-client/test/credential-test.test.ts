// Real inference-shaped calls, fake network: these tests exercise
// `testProviderCredential` against a stub `fetch` that plays the two
// outcomes an onboarding user actually hits — a key the provider
// accepts, and one it rejects with 401 — plus a transport failure, for
// each of the three supported providers. The request itself is built
// by `@intx/inference`'s real adapter for that provider, so what's
// under test is workbench's wiring of that adapter to a fetch call,
// not the wire format (that's Interchange's to test).
import { describe, expect, test } from "bun:test";
import {
  supportedCredentialProviders,
  testProviderCredential,
  type FetchLike,
  type SupportedCredentialProvider,
} from "../src/credential-test";

describe("supportedCredentialProviders", () => {
  test("lists Anthropic, OpenAI, and Google", () => {
    expect(
      supportedCredentialProviders()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["anthropic", "google-genai", "openai"]);
  });
});

describe("testProviderCredential", () => {
  const providers: SupportedCredentialProvider[] = [
    "anthropic",
    "openai",
    "google-genai",
  ];

  for (const provider of providers) {
    test(`${provider}: reports ok when the key is accepted`, async () => {
      const fetchImpl: FetchLike = async () =>
        new Response(JSON.stringify({}), { status: 200 });

      const result = await testProviderCredential({
        provider,
        apiKey: "test-real-key",
        fetchImpl,
      });

      expect(result).toEqual({ ok: true });
    });

    test(`${provider}: reports the specific reason when the key is rejected`, async () => {
      const fetchImpl: FetchLike = async () =>
        new Response(
          JSON.stringify({ error: { message: "invalid api key" } }),
          { status: 401 },
        );

      const result = await testProviderCredential({
        provider,
        apiKey: "test-wrong-key",
        fetchImpl,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("invalid api key");
    });

    test(`${provider}: reports a transport failure without pretending the key is bad`, async () => {
      const fetchImpl: FetchLike = async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      };

      const result = await testProviderCredential({
        provider,
        apiKey: "test-real-key",
        fetchImpl,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("ENOTFOUND");
    });

    test(`${provider}: sends the real API key, never the adapter's sentinel`, async () => {
      let seenHeaders: Record<string, string> = {};
      const fetchImpl: FetchLike = async (_url, init) => {
        seenHeaders = Object.fromEntries(new Headers(init.headers).entries());
        return new Response(JSON.stringify({}), { status: 200 });
      };

      await testProviderCredential({
        provider,
        apiKey: "test-secret-key",
        fetchImpl,
      });

      const sentValues = Object.values(seenHeaders);
      expect(
        sentValues.some((value) => value.includes("test-secret-key")),
      ).toBe(true);
      expect(sentValues).not.toContain("<inject:credential>");
      expect(sentValues).not.toContain("<inject:bearer-credential>");
    });
  }
});
