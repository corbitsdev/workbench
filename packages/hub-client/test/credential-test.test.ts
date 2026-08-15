// Free, fast credential checks, fake network: these tests exercise
// `testProviderCredential` against a stub `fetch` that plays the outcomes
// an onboarding user actually hits against each provider's auth-gated
// probe endpoint — a key the provider accepts, one it rejects, a non-auth
// error from the provider, and a transport failure — for every supported
// provider.
import { describe, expect, test } from "bun:test";
import {
  providerModelSource,
  supportedCredentialProviders,
  testProviderCredential,
  type FetchLike,
  type SupportedCredentialProvider,
} from "../src/credential-test";

describe("supportedCredentialProviders", () => {
  test("lists every supported provider, including the OpenAI-compatible relays", () => {
    expect(
      supportedCredentialProviders()
        .map((p) => p.id)
        .sort(),
    ).toEqual([
      "anthropic",
      "deepseek",
      "google-genai",
      "groq",
      "huggingface",
      "mistral",
      "openai",
      "opencode-zen",
      "openrouter",
      "xai",
    ]);
  });
});

describe("providerModelSource", () => {
  test("maps every OpenAI-compatible relay to the shared 'openai-compatible' adapter", () => {
    for (const provider of [
      "xai",
      "openrouter",
      "opencode-zen",
      "groq",
      "deepseek",
      "mistral",
      "huggingface",
    ] as const) {
      expect(providerModelSource(provider).provider).toBe("openai-compatible");
    }
  });

  test("keeps anthropic, openai, and google-genai on their own adapters", () => {
    expect(providerModelSource("anthropic").provider).toBe("anthropic");
    expect(providerModelSource("openai").provider).toBe("openai");
    expect(providerModelSource("google-genai").provider).toBe("google-genai");
  });
});

describe("testProviderCredential", () => {
  // GET-probed providers: every provider except opencode-zen, whose probe
  // is a POST (see the dedicated describe block below) because its
  // list-models route answers 200 to any key.
  const providers: SupportedCredentialProvider[] = [
    "anthropic",
    "openai",
    "google-genai",
    "openrouter",
    "groq",
    "deepseek",
    "mistral",
    "huggingface",
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
        expect(result.message).toContain("key works");
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

    test(`${provider}: probes the provider's auth-gated endpoint with GET`, async () => {
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
      // OpenRouter's probe is /api/v1/key (its list-models route answers
      // 200 to any key, so it can't prove a credential); Hugging Face's is
      // its own whoami-v2 account endpoint, not the router's model list.
      // Every other GET probe is the provider's list-models endpoint.
      if (provider === "openrouter") {
        expect(seenUrl).toContain("/key");
      } else if (provider === "huggingface") {
        expect(seenUrl).toContain("whoami-v2");
      } else {
        expect(seenUrl).toContain("models");
      }
    });
  }
});

describe("testProviderCredential: xai", () => {
  // xAI's list-models probe is a plain GET like most providers, but its
  // rejected-key response is a 400 with a flat `{ code, error }` body —
  // confirmed against the live endpoint — rather than the 401
  // `{ error: { message } }` shape the generic loop above assumes.
  test("reports ok when the key is accepted", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 });

    const result = await testProviderCredential({
      provider: "xai",
      apiKey: "test-real-key",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
  });

  test("reports the specific reason when the key is rejected", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          code: "invalid-argument",
          error:
            "Incorrect API key provided. You can obtain an API key from https://console.x.ai.",
        }),
        { status: 400 },
      );

    const result = await testProviderCredential({
      provider: "xai",
      apiKey: "test-wrong-key",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        "Incorrect API key provided. You can obtain an API key from https://console.x.ai.",
      );
    }
  });

  test("distinguishes a non-auth provider error from a rejected key", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ code: "internal-error", error: "server exploded" }),
        { status: 500 },
      );

    const result = await testProviderCredential({
      provider: "xai",
      apiKey: "test-real-key",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("key works");
      expect(result.message).toContain("server exploded");
    }
  });

  test("a 400 that isn't the invalid-argument code is not treated as a rejected key", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ code: "some-other-code", error: "unrelated" }),
        { status: 400 },
      );

    const result = await testProviderCredential({
      provider: "xai",
      apiKey: "test-real-key",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("key works");
  });

  test("probes /v1/models with GET and the real key", async () => {
    let seenMethod = "";
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      seenHeaders = Object.fromEntries(new Headers(init.headers).entries());
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    await testProviderCredential({
      provider: "xai",
      apiKey: "test-secret-key",
      fetchImpl,
    });

    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("https://api.x.ai/v1/models");
    expect(seenHeaders["authorization"]).toContain("test-secret-key");
  });
});

describe("testProviderCredential: opencode-zen", () => {
  // Zen's own list-models route (like OpenRouter's) answers 200 to any
  // key, so its probe POSTs a chat-completion body with a real, catalog-
  // confirmed model and an empty `messages` array instead — its gateway
  // rejects a bad key with 401 before ever validating the body, proving
  // the key with the same "spend nothing" guarantee as a GET list-models
  // probe.
  test("reports ok when the key is accepted", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          error: { type: "InvalidRequestError", message: "messages is empty" },
        }),
        { status: 400 },
      );

    const result = await testProviderCredential({
      provider: "opencode-zen",
      apiKey: "test-real-key",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
  });

  test("reports the specific reason when the key is rejected", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          error: { type: "AuthError", message: "Invalid API key." },
        }),
        { status: 401 },
      );

    const result = await testProviderCredential({
      provider: "opencode-zen",
      apiKey: "test-wrong-key",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.toLowerCase()).toContain("invalid api key");
    }
  });

  test("probes with a real-model, empty-messages POST to the chat-completions endpoint, never GET", async () => {
    let seenMethod = "";
    let seenUrl = "";
    let seenBody: string | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      seenBody = init.body;
      return new Response(
        JSON.stringify({ error: { message: "messages is empty" } }),
        { status: 400 },
      );
    };

    await testProviderCredential({
      provider: "opencode-zen",
      apiKey: "test-real-key",
      fetchImpl,
    });

    expect(seenMethod).toBe("POST");
    expect(seenUrl).toContain("chat/completions");
    const body = JSON.parse(seenBody ?? "{}") as {
      model?: string;
      messages?: unknown[];
    };
    // Never an empty or foreign model id — CL-6076: an absent `model`
    // trips Zen's own error-message templating, which used to leak an
    // unrendered `{{model}}` placeholder straight through to the user.
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.messages).toEqual([]);
  });

  test("sends the real API key, never a placeholder", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      seenHeaders = Object.fromEntries(new Headers(init.headers).entries());
      return new Response(JSON.stringify({}), { status: 400 });
    };

    await testProviderCredential({
      provider: "opencode-zen",
      apiKey: "test-secret-key",
      fetchImpl,
    });

    expect(seenHeaders["authorization"]).toContain("test-secret-key");
  });

  // CL-6076 regression: a working key that hits some other problem must
  // never surface the provider's raw, unrendered template syntax, and its
  // copy must say the key works rather than reading like a bad-credential
  // error.
  test("never surfaces a provider's unrendered template placeholder, even on an unrecognized status", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          error: { message: "Model {{model}} is not supported" },
        }),
        { status: 422 },
      );

    const result = await testProviderCredential({
      provider: "opencode-zen",
      apiKey: "test-real-key",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("{{");
      expect(result.message).not.toContain("}}");
    }
  });

  test("tells a working key apart from a rejected one: same provider text, two different messages", async () => {
    const workingKeyOtherProblem: FetchLike = async () =>
      new Response(
        JSON.stringify({ error: { message: "temporarily unavailable" } }),
        { status: 422 },
      );
    const rejectedKey: FetchLike = async () =>
      new Response(
        JSON.stringify({ error: { message: "temporarily unavailable" } }),
        { status: 401 },
      );

    const workingResult = await testProviderCredential({
      provider: "opencode-zen",
      apiKey: "test-real-key",
      fetchImpl: workingKeyOtherProblem,
    });
    const rejectedResult = await testProviderCredential({
      provider: "opencode-zen",
      apiKey: "test-wrong-key",
      fetchImpl: rejectedKey,
    });

    expect(workingResult.ok).toBe(false);
    expect(rejectedResult.ok).toBe(false);
    if (!workingResult.ok && !rejectedResult.ok) {
      expect(workingResult.message).toContain("key works");
      expect(rejectedResult.message).not.toContain("key works");
      expect(workingResult.message).not.toBe(rejectedResult.message);
    }
  });
});
