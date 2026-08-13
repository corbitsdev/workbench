// Free, fast credential checks, fake network: these tests exercise
// `testProviderCredential` against a stub `fetch` that plays the outcomes
// an onboarding user actually hits against each provider's list-models
// endpoint — a key the provider accepts, one it rejects, a non-auth error
// from the provider, and a transport failure — for each of the three
// supported providers.
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

  // Google's list-models endpoint rejects a bad key with 400
  // INVALID_ARGUMENT rather than 401/403.
  const rejectedKeyResponse = (
    provider: SupportedCredentialProvider,
  ): Response =>
    provider === "google-genai"
      ? new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: "API key not valid. Please pass a valid API key.",
              status: "INVALID_ARGUMENT",
            },
          }),
          { status: 400 },
        )
      : new Response(
          JSON.stringify({ error: { message: "invalid api key" } }),
          { status: 401 },
        );

  for (const provider of providers) {
    test(`${provider}: reports ok when the key is accepted`, async () => {
      const fetchImpl: FetchLike = async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 });

      const result = await testProviderCredential({
        provider,
        apiKey: "test-real-key",
        fetchImpl,
      });

      expect(result).toEqual({ ok: true });
    });

    test(`${provider}: reports the specific reason when the key is rejected`, async () => {
      const fetchImpl: FetchLike = async () => rejectedKeyResponse(provider);

      const result = await testProviderCredential({
        provider,
        apiKey: "test-wrong-key",
        fetchImpl,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message.toLowerCase()).toContain(
          provider === "google-genai" ? "api key not valid" : "invalid api key",
        );
      }
    });

    test(`${provider}: distinguishes a non-auth provider error from a rejected key`, async () => {
      const fetchImpl: FetchLike = async () =>
        new Response(
          JSON.stringify({ error: { message: "internal server error" } }),
          { status: 500 },
        );

      const result = await testProviderCredential({
        provider,
        apiKey: "test-real-key",
        fetchImpl,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("not a rejected key");
        expect(result.message).toContain("internal server error");
      }
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

    test(`${provider}: sends the real API key, never a placeholder`, async () => {
      let seenUrl = "";
      let seenHeaders: Record<string, string> = {};
      const fetchImpl: FetchLike = async (url, init) => {
        seenUrl = url;
        seenHeaders = Object.fromEntries(new Headers(init.headers).entries());
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      };

      await testProviderCredential({
        provider,
        apiKey: "test-secret-key",
        fetchImpl,
      });

      const carriesKey =
        seenUrl.includes("test-secret-key") ||
        Object.values(seenHeaders).some((value) =>
          value.includes("test-secret-key"),
        );
      expect(carriesKey).toBe(true);
    });

    test(`${provider}: probes the provider's list-models endpoint with GET`, async () => {
      let seenMethod = "";
      let seenUrl = "";
      const fetchImpl: FetchLike = async (url, init) => {
        seenUrl = url;
        seenMethod = init.method;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      };

      await testProviderCredential({
        provider,
        apiKey: "test-real-key",
        fetchImpl,
      });

      expect(seenMethod).toBe("GET");
      expect(seenUrl).toContain("models");
    });
  }
});
