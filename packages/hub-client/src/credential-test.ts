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
//
// Imported by the browser (the onboarding wizard's provider list) through
// the package's `./credential-test` subpath, not its default export — the
// default export pulls in the seed workflows and their `@intx/inference`
// dependency, which have no business in a browser bundle. This module has
// zero imports beyond arktype and bundles cleanly.

import { type } from "arktype";

export type SupportedCredentialProvider =
  | "anthropic"
  | "openai"
  | "google-genai"
  | "xai"
  | "openrouter"
  | "opencode-zen"
  | "groq"
  | "deepseek"
  | "mistral"
  | "huggingface"
  | "ollama";

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
  /**
   * Overrides the provider's own `PROVIDER_TEST_CONFIG` base URL for this
   * one probe. Every curated provider today has a fixed origin, so this
   * is unused for all of them except `ollama`, whose whole point is
   * running against whatever origin the person actually pointed their
   * local (or tailscale-tunneled) Ollama instance at — see this
   * provider's own config entry below for the URL shape this accepts
   * (the plain root, e.g. `http://localhost:11434`, never the
   * OpenAI-compatible `/v1` suffix).
   */
  readonly baseURL?: string;
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

export type ProviderTestConfig = {
  readonly displayName: string;
  readonly baseURL: string;
  readonly adapterPlugin: AdapterPluginId;
  /** A small, broadly-available model — good enough as the bench's default
   * once the credential is stored, never a claim about how this test
   * itself validates the key (it never calls this model). */
  readonly probeModel: string;
  /** Builds the free probe request that proves the key without spending a
   * token: same auth layer a completion would hit, no generation cost.
   * `baseURL` is the resolved origin for this probe — `config.baseURL`
   * for every provider except `ollama`, which threads a caller-supplied
   * override through here (see `TestProviderCredentialArgs.baseURL`). */
  readonly buildProbeRequest: (apiKey: string, baseURL: string) => ProbeRequest;
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

// The one model this repo's own catalog (`CATALOG_SEEDS["opencode-zen"]`)
// confirms Zen actually serves — never an empty or foreign model id. Zen's
// own error-message templating leaves an unrendered `{{model}}` in its
// response when a request omits `model` entirely, so the probe must always
// name a real one, not rely on Zen's missing-field validation to prove the
// key.
const OPENCODE_ZEN_PROBE_MODEL = "claude-sonnet-5";

const GoogleErrorBody = type({ "error?": { "status?": "string" } });

// xAI's list-models rejection carries the message as a bare string
// (`{ code, error }`), not nested under `error.message` like the other
// OpenAI-shaped providers, so its rejection check reads `code` directly
// instead of matching the shared `ErrorBody` shape below.
const XaiErrorBody = type({ "code?": "string" });

// Ollama needs no key — it serves whatever is running on the machine (or
// tunneled origin) it was pointed at with no auth layer at all. Every
// other provider's credential row stores a real secret; Ollama's stores
// this instead, so the credential machinery (which assumes every row
// carries *some* secret) never special-cases "no secret" as a distinct
// shape. Never a real secret — named so it reads as an obvious
// placeholder if it ever surfaces in a log line or a bug report.
export const OLLAMA_PLACEHOLDER_SECRET = "ollama";

const OLLAMA_PROBE_MODEL = "qwen3.8:27b";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The plain Ollama origin (no `/v1` suffix) a native endpoint like
 * `/api/tags` lives at, derived from whatever shape the caller supplied
 * — the plain root a person types into the onboarding URL field
 * (`http://localhost:11434`), or the OpenAI-compatible `/v1` form
 * (`http://localhost:11434/v1`) already stored on a catalog provider row.
 * Idempotent either way, so a caller never has to know which shape it's
 * holding before calling this.
 */
export function ollamaApiRoot(baseURL: string): string {
  const trimmed = stripTrailingSlash(baseURL);
  return trimmed.endsWith("/v1")
    ? stripTrailingSlash(trimmed.slice(0, -"/v1".length))
    : trimmed;
}

/**
 * The OpenAI-compatible `/v1` origin the `openai-compatible` adapter
 * actually dials for chat completions, derived from whatever shape the
 * caller supplied — see `ollamaApiRoot`, which this builds on.
 */
export function ollamaOpenAICompatBaseURL(baseURL: string): string {
  return `${ollamaApiRoot(baseURL)}/v1`;
}

export const PROVIDER_TEST_CONFIG: Readonly<
  Record<SupportedCredentialProvider, ProviderTestConfig>
> = {
  anthropic: {
    displayName: "Anthropic",
    baseURL: "https://api.anthropic.com",
    adapterPlugin: "anthropic",
    probeModel: "claude-sonnet-5",
    buildProbeRequest: (apiKey, _baseURL) => ({
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
    buildProbeRequest: (apiKey, _baseURL) => ({
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
    buildProbeRequest: (apiKey, _baseURL) => ({
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
  xai: {
    displayName: "xAI",
    baseURL: "https://api.x.ai/v1",
    adapterPlugin: "openai-compatible",
    probeModel: "grok-4.6",
    buildProbeRequest: (apiKey, _baseURL) => ({
      url: "https://api.x.ai/v1/models",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    // Confirmed live: a bad key gets a 400 with
    // `{ code: "invalid-argument", error: "Incorrect API key provided..." }`,
    // not the 401 most Bearer-token providers use.
    isKeyRejected: (status, body) => {
      if (status !== 400) return false;
      const parsed = XaiErrorBody(JSON.parse(body));
      if (parsed instanceof type.errors) return false;
      return parsed.code === "invalid-argument";
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
    buildProbeRequest: (apiKey, _baseURL) => ({
      url: "https://openrouter.ai/api/v1/key",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    isKeyRejected: (status) => status === 401,
  },
  "opencode-zen": {
    displayName: "Opencode Zen",
    baseURL: "https://opencode.ai/zen/v1",
    adapterPlugin: "openai-compatible",
    probeModel: OPENCODE_ZEN_PROBE_MODEL,
    // Zen's `/v1/models` is likewise a public, unauthenticated catalog.
    // Its gateway checks auth before it checks the request body, so a
    // deliberately empty *messages* array still 401s on a bad key without
    // ever running inference — the same "prove the key, spend nothing"
    // guarantee the GET probes give the other providers. `model` is always
    // a real, catalog-confirmed id (never omitted): an absent `model`
    // trips Zen's own error-message templating, which leaks an unrendered
    // `{{model}}` placeholder into the response body instead of naming
    // anything real.
    buildProbeRequest: (apiKey, _baseURL) => ({
      url: "https://opencode.ai/zen/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: OPENCODE_ZEN_PROBE_MODEL, messages: [] }),
    }),
    // A real key clears auth and reaches Zen's payload validation, which
    // rejects the deliberately empty `messages` array with 400 — that 400,
    // not a 2xx, is this probe's proof the key works, since the body never
    // carries enough to reach a 2xx.
    isKeyAccepted: (status) => status === 400,
    isKeyRejected: (status) => status === 401,
  },
  groq: {
    displayName: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    adapterPlugin: "openai-compatible",
    probeModel: "llama-3.3-70b-versatile",
    buildProbeRequest: (apiKey, _baseURL) => ({
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
    buildProbeRequest: (apiKey, _baseURL) => ({
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
    buildProbeRequest: (apiKey, _baseURL) => ({
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
    buildProbeRequest: (apiKey, _baseURL) => ({
      url: "https://huggingface.co/api/whoami-v2",
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    isKeyRejected: (status) => status === 401,
  },
  ollama: {
    displayName: "Ollama (local)",
    // The plain root, not the `/v1` OpenAI-compatible form — this is
    // what the onboarding URL field defaults to and what `/api/tags`
    // (this probe) and `/api/*` generally live under. `providerModelSource`
    // derives the `/v1` form this provider actually deploys workflows
    // against (`ollamaOpenAICompatBaseURL`) from this same value.
    baseURL: "http://localhost:11434",
    adapterPlugin: "openai-compatible",
    probeModel: OLLAMA_PROBE_MODEL,
    // No auth layer to prove a key against — this probes reachability
    // instead: `GET /api/tags` is Ollama's own model-list endpoint,
    // answered by any locally (or tailscale-) running instance with no
    // credential at all.
    buildProbeRequest: (_apiKey, baseURL) => ({
      url: `${ollamaApiRoot(baseURL)}/api/tags`,
      headers: {},
    }),
    // Nothing here is ever really "a rejected key" — Ollama has none —
    // but every response that reaches this branch already failed the
    // `response.ok` check above, so it is honestly a probe failure
    // either way; reusing the "rejected" branch surfaces the provider's
    // own status/body instead of the generic transport-failure message.
    isKeyRejected: () => true,
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
 * different one. `baseURLOverride` is the configurable-base-URL seam
 * every other provider ignores (a fixed origin) and `ollama` uses (the
 * root a person actually pointed their instance at, converted here to
 * the `/v1` form the `openai-compatible` adapter dials). */
export function providerModelSource(
  provider: SupportedCredentialProvider,
  baseURLOverride?: string,
): ProviderModelSource {
  const config = PROVIDER_TEST_CONFIG[provider];
  const base = baseURLOverride ?? config.baseURL;
  return {
    provider: config.adapterPlugin,
    model: config.probeModel,
    baseURL: provider === "ollama" ? ollamaOpenAICompatBaseURL(base) : base,
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

// xAI's error body carries its message as a bare string (`error`), not
// nested under `error.message` like the other providers — tried once the
// nested shape above doesn't match.
const FlatErrorBody = type({ "error?": "string" });

// A provider's error body is data, not copy: some providers (Zen among
// them) build their error text with their own server-side templating, and
// that templating can leak an unrendered `{{placeholder}}` when the field
// it names was never supplied. Template syntax must never reach the user
// as if it were a real error — this is the only gate every provider
// message passes through before display.
const UNRENDERED_TEMPLATE_PATTERN = /\{\{\s*\S+?\s*\}\}/;

function sanitizeProviderText(displayName: string, text: string): string {
  return UNRENDERED_TEMPLATE_PATTERN.test(text)
    ? `${displayName} rejected the request but its response did not explain why.`
    : text;
}

function providerErrorMessage(
  displayName: string,
  status: number,
  body: string,
): string {
  try {
    const parsedJson: unknown = JSON.parse(body);
    const nested = ErrorBody(parsedJson);
    if (!(nested instanceof type.errors) && nested.error?.message) {
      return sanitizeProviderText(displayName, nested.error.message);
    }
    const flat = FlatErrorBody(parsedJson);
    if (!(flat instanceof type.errors) && flat.error) {
      return sanitizeProviderText(displayName, flat.error);
    }
  } catch {
    // Not JSON, or didn't match either shape — fall through to the
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
  const probe = config.buildProbeRequest(
    args.apiKey,
    args.baseURL ?? config.baseURL,
  );

  const requestInitBase = {
    method: probe.method ?? "GET",
    headers: new Headers(probe.headers),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  };

  let response: Response;
  try {
    response = await doFetch(
      probe.url,
      probe.body !== undefined
        ? { ...requestInitBase, body: probe.body }
        : requestInitBase,
    );
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
  // Not a rejected key — the provider's own auth layer let this request
  // through — so this is a working key hitting some other problem, not a
  // bad credential. Say so plainly instead of a generic "unexpected
  // error" that reads as if the key itself might be at fault.
  return {
    ok: false,
    message: `Your ${config.displayName} key works — the test request itself failed: ${providerErrorMessage(config.displayName, response.status, body)}`,
  };
}

const OllamaTagsResponse = type({
  models: type({ name: "string" }).array(),
});

export type OllamaCatalogModel = {
  readonly canonicalName: string;
  readonly displayName: string;
  /**
   * This exact model's live-probed capabilities (`fetchOllamaModelCapabilities`),
   * already translated into this repo's storable capability vocabulary —
   * bare strings, never narrowed against `Capability` here (this module
   * stays free of `@intx/types`; the narrowing happens where these are
   * consumed, `seedCatalog`'s `ensureCatalogOffering` call). Empty when
   * the instance's `/api/show` answered with no recognized capability
   * (an older Ollama build that predates the field, or a probe that
   * failed) — `seedCatalog` reports that plainly rather than guessing.
   */
  readonly capabilities: readonly string[];
};

const OllamaShowResponse = type({ "capabilities?": "string[]" });

/**
 * Ollama's own capability vocabulary (`/api/show`'s `capabilities` field
 * — `"completion"`, `"embedding"`, `"tools"`, `"vision"`, `"insert"`,
 * confirmed against a live instance), translated to the wire capability
 * strings this repo stores (`WIRE_CAPABILITIES`, `@intx/types`). This is
 * the ONE place that translation happens: `"embedding"` deliberately has
 * no entry — an embedding-only model must never earn `"plain-text"` here,
 * or the whole point of probing (telling it apart from a chat model) is
 * lost. An Ollama capability this map doesn't recognize is dropped, not
 * guessed at.
 */
const OLLAMA_CAPABILITY_MAP: Readonly<Record<string, readonly string[]>> = {
  completion: ["plain-text", "plain-text-streaming"],
  tools: ["function-calling", "function-calling-multi-turn"],
  vision: ["vision-input"],
};

function translateOllamaCapabilities(
  ollamaCapabilities: readonly string[],
): readonly string[] {
  const translated = new Set<string>();
  for (const capability of ollamaCapabilities) {
    for (const wireCapability of OLLAMA_CAPABILITY_MAP[capability] ?? []) {
      translated.add(wireCapability);
    }
  }
  return [...translated];
}

/**
 * Whether `modelName` is completion-capable (as opposed to an
 * embedding-only pull), read straight off the instance's own `POST
 * /api/show` — the live signal `fetchOllamaModelCatalog` probes for
 * every model it lists, so a fresh Ollama connect's offerings carry real
 * capability data instead of the empty list every pulled model used to
 * get (CL-6351's `preferCompletionCapable` had nothing to filter on).
 * Returns an empty list — never throws, never guesses — on any failure
 * (unreachable origin, malformed response, an Ollama build old enough
 * that `/api/show` carries no `capabilities` field at all).
 */
export async function fetchOllamaModelCapabilities(
  baseURL: string,
  modelName: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<readonly string[]> {
  try {
    const response = await fetchImpl(`${ollamaApiRoot(baseURL)}/api/show`, {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      body: JSON.stringify({ model: modelName }),
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    const parsed = OllamaShowResponse(body);
    if (parsed instanceof type.errors) return [];
    return translateOllamaCapabilities(parsed.capabilities ?? []);
  } catch {
    return [];
  }
}

/**
 * The live model list a reachable Ollama instance actually serves right
 * now, read straight off its own `GET /api/tags` — never the curated
 * static seed (`CATALOG_SEEDS.ollama`), which only exists as the
 * fallback for a connect attempt this can't reach. Returns `undefined`
 * on any failure (unreachable origin, malformed response, zero models):
 * every caller treats that as "fall back to the static seed," never as
 * an error to surface — `credential-test.ts`'s own probe already covers
 * telling the person their instance is unreachable.
 *
 * Each listed model is also probed for its own capabilities
 * (`fetchOllamaModelCapabilities`) so the catalog this seeds never has
 * to fall back to a heuristic (name-sorting, a curated allowlist) to
 * tell a chat model from an embedding one (CL-6351/CL-6366).
 */
export async function fetchOllamaModelCatalog(
  baseURL: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<readonly OllamaCatalogModel[] | undefined> {
  try {
    const response = await fetchImpl(`${ollamaApiRoot(baseURL)}/api/tags`, {
      method: "GET",
      headers: new Headers(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const parsed = OllamaTagsResponse(body);
    if (parsed instanceof type.errors || parsed.models.length === 0) {
      return undefined;
    }
    return await Promise.all(
      parsed.models.map(async (model) => ({
        canonicalName: model.name,
        displayName: model.name,
        capabilities: await fetchOllamaModelCapabilities(
          baseURL,
          model.name,
          fetchImpl,
        ),
      })),
    );
  } catch {
    return undefined;
  }
}
