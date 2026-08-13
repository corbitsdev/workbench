// A real, free test call for a credential a person is about to hand the
// onboarding flow, made before it's ever stored: each provider's own
// list-models endpoint, authenticated with the real key. This proves the
// key the same way a paid completion would — the provider still checks
// it against its auth layer before the workbench ever sees a response —
// without spending a token or paying for inference. Only the transport
// (one `fetch`, GET, no body) and the pass/fail verdict belong to
// workbench; the endpoints and their auth schemes are each provider's own.

import { type } from "arktype";

export type SupportedCredentialProvider =
  "anthropic" | "openai" | "google-genai";

export type CredentialTestResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export type FetchLike = (
  url: string,
  init: { method: "GET"; headers: Headers; signal: AbortSignal },
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
};

type ProviderTestConfig = {
  readonly displayName: string;
  readonly baseURL: string;
  /** A small, broadly-available model — good enough as the bench's default
   * once the credential is stored, never a claim about how this test
   * itself validates the key (it never calls this model). */
  readonly probeModel: string;
  /** Builds the free list-models request that proves the key without
   * spending a token: same auth layer a completion would hit, no
   * generation cost. */
  readonly buildProbeRequest: (apiKey: string) => ProbeRequest;
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
};

export type ProviderModelSource = {
  readonly provider: SupportedCredentialProvider;
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
  return { provider, model: config.probeModel, baseURL: config.baseURL };
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
 * Probes the provider's own list-models endpoint — a free, authenticated
 * GET that still runs the real key through the provider's auth layer —
 * to prove a credential works without spending a token or waiting on a
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
      method: "GET",
      headers: new Headers(probe.headers),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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

  if (response.ok) return { ok: true };

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
