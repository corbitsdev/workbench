// The mechanics of OpenRouter's registration-free PKCE connect
// (openrouter.ai/docs — OAuth PKCE): the code-for-key exchange, on top
// of the PKCE and single-use state primitives shared with every connect
// flow (`./pkce.ts`). OpenRouter's flow returns a durable user-scoped
// API key — not an expiring token — so everything after the exchange is
// the ordinary api_key credential path. The key itself is never logged
// and never put in a URL.

import { type } from "arktype";

import {
  postExchangeRequest,
  type OAuthExchangeFetch,
} from "./oauth-exchange-fetch";

export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEY_EXCHANGE_URL =
  "https://openrouter.ai/api/v1/auth/keys";

/** OpenRouter authorization codes expire in 10 minutes; a pending
 * connect is worthless after that, so its state is too. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

const KeyExchangeResponse = type({ key: "string > 0" });

export type ExchangeResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly message: string };

export type ExchangeFetch = OAuthExchangeFetch;

export type ExchangeCodeForKeyArgs = {
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetchImpl?: ExchangeFetch;
};

/**
 * Trades an authorization code and its verifier for the user-scoped
 * OpenRouter API key. Failure messages describe the exchange, never
 * the key — there is no path on which key material reaches a log line
 * or an error string.
 */
export async function exchangeCodeForKey(
  args: ExchangeCodeForKeyArgs,
): Promise<ExchangeResult> {
  const doFetch = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await postExchangeRequest(doFetch, OPENROUTER_KEY_EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: args.code,
        code_verifier: args.codeVerifier,
        code_challenge_method: "S256",
      }),
    });
  } catch (cause) {
    return {
      ok: false,
      message:
        cause instanceof Error
          ? `Could not reach OpenRouter: ${cause.message}`
          : `Could not reach OpenRouter: ${String(cause)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `OpenRouter rejected the code exchange with status ${response.status}`,
    };
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = KeyExchangeResponse(body);
  if (parsed instanceof type.errors) {
    return {
      ok: false,
      message: "OpenRouter's exchange response did not carry a key",
    };
  }
  return { ok: true, key: parsed.key };
}
