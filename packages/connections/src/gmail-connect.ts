// The mechanics of the hosted Gmail connect — a confidential-client
// Google OAuth code flow, the same shape as `./github-connect.ts` with
// Google's own parameter names. Distinct from `GOOGLE_CLIENT_ID`/
// `GOOGLE_CLIENT_SECRET` (`apps/hub/src/config.ts`), which register a
// *separate* OAuth app used only for signing in to Workbench itself —
// this exchange is for the `gmail` connector's own app
// (`GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`), registered independently
// so a self-hoster can turn on the mailbox connect without touching
// sign-in. Google access tokens expire in about an hour, so the
// exchange surfaces the refresh token (`access_type=offline` on the
// authorize URL) for the credential row to keep alongside the secret.

import { type } from "arktype";

export const GOOGLE_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_EXCHANGE_URL = "https://oauth2.googleapis.com/token";

/** Read, draft, and send — `gmail.modify` covers all three without
 * granting permanent deletion (that stays behind the full
 * `mail.google.com` scope, which nothing here asks for). */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const TokenExchangeResponse = type({
  "access_token?": "string > 0",
  "expires_in?": "number",
  "refresh_token?": "string > 0",
  "error?": "string",
  "error_description?": "string",
});

export type GoogleExchangeResult =
  | {
      readonly ok: true;
      readonly apiKey: string;
      readonly expiresAt?: string;
      readonly refreshToken?: string;
    }
  | { readonly ok: false; readonly message: string };

export type ExchangeCodeForGoogleTokenArgs = {
  readonly code: string;
  readonly codeVerifier?: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetchImpl?: (
    url: string,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
    },
  ) => Promise<Response>;
};

/**
 * Trades an authorization code for a Google access token (plus expiry
 * and refresh token when Google issues them). Failure messages describe
 * the exchange, never the material — no token or client secret reaches
 * an error string.
 */
export async function exchangeCodeForGoogleToken(
  args: ExchangeCodeForGoogleTokenArgs,
): Promise<GoogleExchangeResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
  });
  if (args.codeVerifier !== undefined) {
    params.set("code_verifier", args.codeVerifier);
  }

  let response: Response;
  try {
    response = await doFetch(GOOGLE_TOKEN_EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, message: `Google token exchange failed: ${message}` };
  }

  const raw: unknown = await response.json().catch(() => undefined);
  const parsed = TokenExchangeResponse(raw);
  if (parsed instanceof type.errors) {
    return {
      ok: false,
      message: `Google token exchange returned an unexpected shape: ${parsed.summary}`,
    };
  }
  if (parsed.access_token === undefined) {
    const error = parsed.error ?? `HTTP ${response.status}`;
    const detail =
      parsed.error_description !== undefined
        ? `: ${parsed.error_description}`
        : "";
    return {
      ok: false,
      message: `Google token exchange failed (${error}${detail})`,
    };
  }
  return {
    ok: true,
    apiKey: parsed.access_token,
    ...(parsed.expires_in !== undefined
      ? {
          expiresAt: new Date(
            Date.now() + parsed.expires_in * 1000,
          ).toISOString(),
        }
      : {}),
    ...(parsed.refresh_token !== undefined
      ? { refreshToken: parsed.refresh_token }
      : {}),
  };
}
