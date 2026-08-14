// A real, free test call for a credential a person is about to hand the
// onboarding flow, made before it's ever stored: each provider's own
// auth-gated endpoint (almost always list-models; Zen's is an empty
// chat-completion whose auth check runs first), authenticated with the
// real key. This proves the key the same way a paid completion would —
// the provider still checks it against its auth layer before the
// workbench ever sees a response — without spending a token or paying
// for inference. Only the transport (one `fetch`, pass/fail verdict)
// belongs to workbench; the endpoints and their auth schemes are each
// provider's own.

import { type } from "arktype";

export type SupportedCredentialProvider =
  | "anthropic"
  | "openai"
  | "google-genai"
  | "openrouter"
  | "opencode-zen"
  | "groq"
  | "deepseek"
  | "mistral"
  | "huggingface";

/**
 * The inference adapter (`@intx/inference`'s runtime provider registry,
 * mirrored by `@intx/types`' `ModelProviderPlugin`) that actually serves a
 * credential's requests. Deliberately narrower than
 * `SupportedCredentialProvider`: OpenRouter, Opencode Zen, Groq, DeepSeek,
 * Mistral, and Hugging Face each get their own credential-test probe and onboarding
 * card, but at deploy time they all ride the same OpenAI-compatible wire
 * shape, so their `ModelSource.provider` and catalog `plugin` value must be
 * `"openai-compatible"` — the registry key `byProvider.get(source.provider)`
 * resolves against — never their own provider id.
 */
export type AdapterPluginId =
  "anthropic" | "openai" | "openai-compatible" | "google-genai";

export type CredentialTestResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export type FetchLike = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Headers;
    signal: AbortSignal;
    body?: string;
  },
) => Promise<Response>;

export type TestProviderCredentialArgs = {
  readonly provider: SupportedCredentialProvider;
  readonly apiKey: string;
  readonly fetchImpl?: FetchLike;
};

const PROBE_TIMEOUT_MS = 5000;

type ProbeRequest = {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** Defaults to GET. Opencode Zen has no unauthenticated-safe list-models
   * route (its `/v1/models` is a public catalog that answers 200 to any
   * key, real or not) — its probe instead POSTs an empty completion body
   * to its own chat endpoint, which its gateway rejects with 401 before
   * ever touching a model, proving the key with no generation cost. */
  readonly method?: "GET" | "POST";
  readonly body?: string;
};

type ProviderTestConfig = {
  readonly displayName: string;
  readonly baseURL: string;
  readonly adapterPlugin: AdapterPluginId;
  /** A small, broadly-available model — good enough as the bench's default
   * once the credential is stored, never a claim about how this test
   * itself validates the key (it never calls this model). */
  readonly probeModel: string;
  /** Builds the free probe request that proves the key without spending a
   * token: same auth layer a completion would hit, no generation cost. */
  readonly buildProbeRequest: (apiKey: string) => ProbeRequest;
  /** Whether this status means "the probe proved the key," overriding the
   * default `response.ok` (2xx) check. Only Opencode Zen's probe needs
   * this: its empty-body POST can never succeed with a 2xx — the gateway
   * always reaches the missing-`model` validation error after a real key
   * clears auth — so a 400 there is the success signal, not a 2xx. */
  readonly isKeyAccepted?: (status: number) => boolean;
  /** Whether this status/body pair means "the provider rejected the key,"
   * as opposed to a network problem or some other failure — each
   * provider maps auth failures to its own status code. */
  readonly isKeyRejected: (status: number, body: string) => boolean;
};

const ANTHROPIC_VERSION = "2023-06-01";

const GoogleErrorBody = type({ "error?": { "status?": "string" } });

const PROVIDER_TEST_CONFIG: Readonly<
  Record<SupportedCredentialProvider, ProviderTestConfig>
> = {
  anthropic: {
    displayName: "Anthropic",
    baseURL: "https://api.anthropic.com",
    adapterPlugin: "anthropic",
    probeModel: "claude-sonnet-5",
    buildProbeRequest: (apiKey) => ({
      url: "https://api.anthropic.com/v1/models",
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    }),
    isKeyRejected: (status) => status === 401 || status === 403,
  },
  openai: {
    displayName: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    adapterPlugin: "openai",
    probeModel: "gpt-4o-mini",
    buildProbeRequest: (apiKey) => ({
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    isKeyRejected: (status) => status === 401,
  },
  "google-genai": {
    displayName: "Google",
    baseURL: "https://generativelanguage.googleapis.com",
    adapterPlugin: "google-genai",
    probeModel: "gemini-2.5-flash",
    buildProbeRequest: (apiKey) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      headers: {},
    }),
    // Google's list-models endpoint rejects a bad key with 400
    // INVALID_ARGUMENT, not 401/403 — it's an API-key query param, not a
    // bearer credential the auth layer inspects first.
    isKeyRejected: (status, body) => {
      if (status !== 400) return false;
      const parsed = GoogleErrorBody(JSON.parse(body));
      if (parsed instanceof type.errors) return false;
      return parsed.error?.status === "INVALID_ARGUMENT";
    },
  },
  openrouter: {
    displayName: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    adapterPlugin: "openai-compatible",
    probeModel: "anthropic/claude-sonnet-5",
    // OpenRouter's own `/api/v1/models` is a public catalog that answers
    // 200 to any request, key or no key — it cannot prove a credential.
    // `/api/v1/key` is the documented account/key-status endpoint and the
    // one OpenRouter's own docs say answers 401 for a missing, invalid,
    // disabled, or expired key.
    buildProbeRequest: (apiKey) => ({
      url: "https://openrouter.ai/api/v1/key",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    isKeyRejected: (status) => status === 401,
  },
  "opencode-zen": {
    displayName: "Opencode Zen",
    baseURL: "https://opencode.ai/zen/v1",
    adapterPlugin: "openai-compatible",
    probeModel: "claude-sonnet-5",
    // Zen's `/v1/models` is likewise a public, unauthenticated catalog.
    // Its gateway checks auth before it checks the request body, so an
    // empty chat-completion POST still 401s on a bad key without ever
    // reaching a model — the same "prove the key, spend nothing"
    // guarantee the GET probes give the other providers.
    buildProbeRequest: (apiKey) => ({
      url: "https://opencode.ai/zen/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: "{}",
    }),
    // A real key clears auth and reaches Zen's payload validation, which
    // rejects the deliberately empty body with 400 ("Model ... is not
    // supported") — that 400, not a 2xx, is this probe's proof the key
    // works, since the body never carries enough to reach a 2xx.
    isKeyAccepted: (status) => status === 400,
    isKeyRejected: (status) => status === 401,
  },
  groq: {
    displayName: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    adapterPlugin: "openai-compatible",
    probeModel: "llama-3.3-70b-versatile",
    buildProbeRequest: (apiKey) => ({
      url: "https://api.groq.com/openai/v1/models",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    isKeyRejected: (status) => status === 401,
  },
  deepseek: {
    displayName: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    adapterPlugin: "openai-compatible",
    probeModel: "deepseek-v4-flash",
    buildProbeRequest: (apiKey) => ({
      url: "https://api.deepseek.com/models",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    isKeyRejected: (status) => status === 401,
  },
  mistral: {
    displayName: "Mistral",
    baseURL: "https://api.mistral.ai/v1",
    adapterPlugin: "openai-compatible",
    probeModel: "mistral-small-2603",
    buildProbeRequest: (apiKey) => ({
      url: "https://api.mistral.ai/v1/models",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    isKeyRejected: (status) => status === 401,
  },
  huggingface: {
    displayName: "Hugging Face",
    baseURL: "https://router.huggingface.co/v1",
    adapterPlugin: "openai-compatible",
    probeModel: "deepseek-ai/DeepSeek-V4-Flash",
    // HF's own account endpoint, not the router: `whoami-v2` is the
    // documented way to prove a token (huggingface.co/docs/hub/oauth's
    // token-exchange example uses it the same way) and answers a plain
    // 401 for a missing, invalid, or expired token — confirmed live
    // against both `whoami-v2` and the router's own endpoints.
    buildProbeRequest: (apiKey) => ({
      url: "https://huggingface.co/api/whoami-v2",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    isKeyRejected: (status) => status === 401,
  },
};

export type ProviderModelSource = {
  /** The adapter that serves this source, not the credential provider id
   * — see `AdapterPluginId`. A workflow deployment's `sources[].provider`
   * and a catalog provider's `plugin` are both adapter-registry keys, and
   * every OpenAI-compatible relay (OpenRouter, Opencode Zen, Groq,
   * DeepSeek, Mistral) shares the single `"openai-compatible"` key. */
  readonly provider: AdapterPluginId;
  readonly model: string;
  readonly baseURL: string;
};

/** The default model and endpoint a freshly-added credential deploys
 * workflows against, before the person who added it ever picks a
 * different one. */
export function providerModelSource(
  provider: SupportedCredentialProvider,
): ProviderModelSource {
  const config = PROVIDER_TEST_CONFIG[provider];
  return {
    provider: config.adapterPlugin,
    model: config.probeModel,
    baseURL: config.baseURL,
  };
}

export function supportedCredentialProviders(): readonly {
  readonly id: SupportedCredentialProvider;
  readonly displayName: string;
}[] {
  return (
    Object.entries(PROVIDER_TEST_CONFIG) as [
      SupportedCredentialProvider,
      ProviderTestConfig,
    ][]
  ).map(([id, config]) => ({ id, displayName: config.displayName }));
}

const ErrorBody = type({ "error?": { "message?": "string" } });

function providerErrorMessage(
  displayName: string,
  status: number,
  body: string,
): string {
  try {
    const parsed = ErrorBody(JSON.parse(body));
    if (!(parsed instanceof type.errors) && parsed.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // Not JSON, or didn't match the shape — fall through to the
    // generic message below.
  }
  return `${displayName} rejected the request with status ${status}`;
}

/**
 * Probes the provider's own auth layer — almost always a free,
 * authenticated GET against its list-models endpoint, occasionally (Zen)
 * a POST whose auth check runs before the body is ever validated — to
 * prove a credential works without spending a token or waiting on a
 * completion. Never stores or logs the key; the caller owns that decision
 * once this says `ok`.
 */
export async function testProviderCredential(
  args: TestProviderCredentialArgs,
): Promise<CredentialTestResult> {
  const config = PROVIDER_TEST_CONFIG[args.provider];
  const doFetch = args.fetchImpl ?? fetch;
  const probe = config.buildProbeRequest(args.apiKey);

  let response: Response;
  try {
    response = await doFetch(probe.url, {
      method: probe.method ?? "GET",
      headers: new Headers(probe.headers),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      ...(probe.body !== undefined ? { body: probe.body } : {}),
    });
  } catch (cause) {
    return {
      ok: false,
      message:
        cause instanceof Error
          ? `Could not reach ${config.displayName}: ${cause.message}`
          : `Could not reach ${config.displayName}: ${String(cause)}`,
    };
  }

  const accepted = config.isKeyAccepted
    ? config.isKeyAccepted(response.status)
    : response.ok;
  if (accepted) return { ok: true };

  const body = await response.text();
  if (config.isKeyRejected(response.status, body)) {
    return {
      ok: false,
      message: providerErrorMessage(config.displayName, response.status, body),
    };
  }
  return {
    ok: false,
    message: `${config.displayName} returned an unexpected error (not a rejected key): ${providerErrorMessage(config.displayName, response.status, body)}`,
  };
}
