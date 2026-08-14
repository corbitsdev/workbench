// The mechanics of Hugging Face's "Sign in with HF" PKCE connect
// (huggingface.co/docs/hub/en/oauth): a standard OAuth 2.1 authorization
// code + PKCE round trip against a self-serve-registered public OAuth
// app (huggingface.co/settings/applications/new — no client secret; see
// docs/onboarding-huggingface-connect.md for the registration steps).
// Endpoints and PKCE support are confirmed live against
// https://huggingface.co/.well-known/openid-configuration.
//
// Unlike OpenRouter's exchange, HF's token endpoint hands back a
// standard, expiring OAuth access token — no refresh grant is
// documented for this flow (see the CL-5988 research note). The
// `expiresAt` this module computes from `expires_in` is what
// `complete-credential.ts` stores in the credential's `metadata` field,
// the extension point a later expiry sweep reads.

import { type } from "arktype";

import {
  createConnectStateStore,
  generatePKCEPair,
  type ConnectStateStore,
  type PKCEPair,
} from "./pkce";

export { createConnectStateStore, generatePKCEPair };
export type { ConnectStateStore, PKCEPair };

export const HUGGINGFACE_AUTHORIZE_URL =
  "https://huggingface.co/oauth/authorize";
export const HUGGINGFACE_TOKEN_URL = "https://huggingface.co/oauth/token";

/** `inference-api` is the one scope this flow needs: "make inference
 * requests to Inference Providers on behalf of the user." `openid`
 * is requested alongside it only because HF's docs list it as the
 * scope that yields an ID token — not consumed here, but harmless to
 * request and keeps the app's consent screen legible ("sign in"). */
export const HUGGINGFACE_SCOPE = "openid inference-api";

/** HF authorization codes are short-lived, like OpenRouter's; a pending
 * connect is worthless after ten minutes, so its state is too. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

const TokenResponse = type({
  access_token: "string > 0",
  "expires_in?": "number > 0",
});

export type ExchangeResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
      /** ISO instant the token expires, when HF reports `expires_in`. */
      readonly expiresAt?: string;
    }
  | { readonly ok: false; readonly message: string };

export type ExchangeFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<Response>;

export type ExchangeCodeForTokenArgs = {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly fetchImpl?: ExchangeFetch;
  /** Injectable for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
};

/**
 * Trades an authorization code and its verifier for a Hugging Face
 * access token. Failure messages describe the exchange, never the
 * token — there is no path on which token material reaches a log line
 * or an error string.
 */
export async function exchangeCodeForToken(
  args: ExchangeCodeForTokenArgs,
): Promise<ExchangeResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const now = args.now ?? Date.now;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.codeVerifier,
  });

  let response: Response;
  try {
    response = await doFetch(HUGGINGFACE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (cause) {
    return {
      ok: false,
      message:
        cause instanceof Error
          ? `Could not reach Hugging Face: ${cause.message}`
          : `Could not reach Hugging Face: ${String(cause)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `Hugging Face rejected the code exchange with status ${response.status}`,
    };
  }

  const parsed = TokenResponse(await response.json().catch(() => null));
  if (parsed instanceof type.errors) {
    return {
      ok: false,
      message: "Hugging Face's exchange response did not carry an access token",
    };
  }
  return {
    ok: true,
    accessToken: parsed.access_token,
    ...(parsed.expires_in !== undefined
      ? { expiresAt: new Date(now() + parsed.expires_in * 1000).toISOString() }
      : {}),
  };
}
