// A real test call for a credential a person is about to hand the
// onboarding flow, made before it's ever stored: the request is built
// by `@intx/inference`'s own provider adapter — the same code path a
// deployed workflow's inference call goes through — so the wire format
// under test is Interchange's, never workbench's guess at it, for
// whichever provider the user picked. Only the transport (one `fetch`,
// no streaming consumed) and the pass/fail verdict belong to workbench.

import {
  createAnthropicAdapter,
  createGoogleGenAIAdapter,
  createOpenAIAdapter,
} from "@intx/inference/providers";
import {
  BEARER_CREDENTIAL_SENTINEL,
  CREDENTIAL_SENTINEL,
} from "@intx/inference";
import type { AdapterFactory } from "@intx/inference";

export type SupportedCredentialProvider =
  "anthropic" | "openai" | "google-genai";

export type CredentialTestResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Headers; body: string },
) => Promise<Response>;

export type TestProviderCredentialArgs = {
  readonly provider: SupportedCredentialProvider;
  readonly apiKey: string;
  readonly fetchImpl?: FetchLike;
};

type ProviderTestConfig = {
  readonly displayName: string;
  readonly createAdapter: AdapterFactory;
  readonly baseURL: string;
  /** A small, broadly-available model — good enough to prove a key works,
   * never a claim about which model the caller's bench will actually use. */
  readonly probeModel: string;
};

const PROVIDER_TEST_CONFIG: Readonly<
  Record<SupportedCredentialProvider, ProviderTestConfig>
> = {
  anthropic: {
    displayName: "Anthropic",
    createAdapter: createAnthropicAdapter,
    baseURL: "https://api.anthropic.com",
    probeModel: "claude-sonnet-5",
  },
  openai: {
    displayName: "OpenAI",
    createAdapter: createOpenAIAdapter,
    baseURL: "https://api.openai.com/v1",
    probeModel: "gpt-4o-mini",
  },
  "google-genai": {
    displayName: "Google",
    createAdapter: createGoogleGenAIAdapter,
    baseURL: "https://generativelanguage.googleapis.com",
    probeModel: "gemini-2.5-flash",
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

function providerErrorMessage(
  displayName: string,
  status: number,
  body: string,
): string {
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "error" in parsed &&
    typeof (parsed as { error: unknown }).error === "object" &&
    (parsed as { error: unknown }).error !== null &&
    "message" in (parsed as { error: { message: unknown } }).error &&
    typeof (parsed as { error: { message: unknown } }).error.message ===
      "string"
  ) {
    return (parsed as { error: { message: string } }).error.message;
  }
  return `${displayName} rejected the request with status ${status}`;
}

/** Substitutes the real key into whichever sentinel the adapter's built
 * headers carry, without knowing in advance which header that provider
 * uses — the sentinel values are the adapter's own exported contract for
 * exactly this substitution. */
function injectCredential(
  headers: Record<string, string>,
  apiKey: string,
): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === CREDENTIAL_SENTINEL) result.set(name, apiKey);
    else if (value === BEARER_CREDENTIAL_SENTINEL)
      result.set(name, `Bearer ${apiKey}`);
    else result.set(name, value);
  }
  return result;
}

function carriesACredentialSentinel(headers: Record<string, string>): boolean {
  return Object.values(headers).some(
    (value) =>
      value === CREDENTIAL_SENTINEL || value === BEARER_CREDENTIAL_SENTINEL,
  );
}

/**
 * Fires the smallest real call a credential can be validated with — a
 * one-token completion — against whichever provider the caller picked,
 * through that provider's own `@intx/inference` adapter. Never stores or
 * logs the key; the caller owns that decision once this says `ok`.
 */
export async function testProviderCredential(
  args: TestProviderCredentialArgs,
): Promise<CredentialTestResult> {
  const config = PROVIDER_TEST_CONFIG[args.provider];
  const doFetch = args.fetchImpl ?? fetch;
  const adapter = config.createAdapter({
    sourceId: "onboarding-credential-test",
    provider: args.provider,
    model: config.probeModel,
  });

  const request = adapter.buildRequest(
    [
      {
        role: "user",
        content: [{ type: "text", text: "Reply with the word ok." }],
        timestamp: Date.now(),
      },
    ],
    config.probeModel,
    { maxTokens: 1 },
  );

  if (!carriesACredentialSentinel(request.headers)) {
    return {
      ok: false,
      message: `internal error: the ${config.displayName} adapter no longer uses a credential sentinel this test relies on`,
    };
  }
  const headers = injectCredential(request.headers, args.apiKey);

  let response: Response;
  try {
    response = await doFetch(`${config.baseURL}${request.url}`, {
      method: "POST",
      headers,
      body: request.body,
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

  const body = await response.text();

  if (response.ok) return { ok: true };
  return {
    ok: false,
    message: providerErrorMessage(config.displayName, response.status, body),
  };
}
