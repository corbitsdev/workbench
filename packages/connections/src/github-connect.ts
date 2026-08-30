// The mechanics of a hosted GitHub OAuth App connect (github.com/settings/developers
// — a confidential-client web flow, unlike OpenRouter/Hugging Face's public
// PKCE ones): the code-for-token exchange against GitHub's own token
// endpoint. Distinct from `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`
// (`apps/hub/src/config.ts`), which register a *separate* OAuth app used
// only for signing in to Workbench itself — this exchange is for the
// `github` connector's own app, registered independently so a self-hoster
// can turn on the hosted one-click connect without touching sign-in. The
// resulting token is a normal GitHub Bearer token — the same shape a
// pasted PAT already is — so everything after the exchange is the
// ordinary api_key credential path (`registry.ts`'s `github` descriptor
// still names `credentialPlugin: "http"`).

import { type } from "arktype";
import { reportError } from "@corbits/error-sink";

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_EXCHANGE_URL =
  "https://github.com/login/oauth/access_token";

const TokenExchangeResponse = type({
  "access_token?": "string > 0",
  "error?": "string",
  "error_description?": "string",
});

export type ExchangeResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly message: string };

export type ExchangeFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<Response>;

export type ExchangeCodeForGithubTokenArgs = {
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetchImpl?: ExchangeFetch;
};

/**
 * Trades an authorization code for a GitHub OAuth App user access token.
 * Failure messages describe the exchange, never the token — there is no
 * path on which token material reaches a log line or an error string.
 */
export async function exchangeCodeForGithubToken(
  args: ExchangeCodeForGithubTokenArgs,
): Promise<ExchangeResult> {
  const doFetch = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(GITHUB_TOKEN_EXCHANGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code: args.code,
        redirect_uri: args.redirectUri,
      }),
    });
  } catch (cause) {
    reportError(cause, { operation: "exchange_code_for_github_token" });
    return {
      ok: false,
      message:
        cause instanceof Error
          ? `Could not reach GitHub: ${cause.message}`
          : `Could not reach GitHub: ${String(cause)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `GitHub rejected the code exchange with status ${response.status}`,
    };
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = TokenExchangeResponse(body);
  if (parsed instanceof type.errors) {
    return {
      ok: false,
      message: "GitHub's exchange response did not carry a token",
    };
  }
  if (parsed.error !== undefined) {
    return {
      ok: false,
      message: parsed.error_description ?? parsed.error,
    };
  }
  if (parsed.access_token === undefined) {
    return {
      ok: false,
      message: "GitHub's exchange response did not carry a token",
    };
  }
  return { ok: true, key: parsed.access_token };
}
