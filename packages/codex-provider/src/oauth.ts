import {
  baseTokensFromResponse,
  exchangeCode as exchangeSharedCode,
  refreshTokenRequest,
  type BaseTokens,
  type FetchLike,
  type OAuthClientConfig,
  type TokenResponse,
} from "@corbits/oauth-core";
import { type } from "arktype";
import {
  CODEX_AUTHORIZE_EXTRA_PARAMS,
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  CODEX_SCOPES,
  CODEX_TOKEN_TIMEOUT_MS,
  CODEX_TOKEN_URL,
} from "./constants";

/** Tokens issued by Codex's OAuth server: the shared base shape plus the ChatGPT account id. */
export type CodexTokens = BaseTokens & { accountId?: string };

/**
 * The PKCE OAuth client config for Codex ("Login with ChatGPT"). Pass this
 * to `@corbits/oauth-core`'s `buildAuthorizeUrl`, `exchangeCode`, and
 * `refreshTokenRequest`.
 */
export const codexOAuthConfig: OAuthClientConfig = {
  clientId: CODEX_CLIENT_ID,
  authorizeUrl: CODEX_AUTHORIZE_URL,
  tokenUrl: CODEX_TOKEN_URL,
  redirectUri: CODEX_REDIRECT_URI,
  scopes: CODEX_SCOPES,
  extraAuthorizeParams: CODEX_AUTHORIZE_EXTRA_PARAMS,
  tokenTimeoutMs: CODEX_TOKEN_TIMEOUT_MS,
};

const IdTokenClaims = type({
  "chatgpt_account_id?": "string",
  "https://api.openai.com/auth?": {
    "chatgpt_account_id?": "string",
  },
});

/**
 * Decodes the ChatGPT account id out of an `id_token` (a JWT). The claim
 * lives at `chatgpt_account_id` or nested under the
 * `https://api.openai.com/auth` claim. Only the payload segment is read;
 * the signature is not verified here because the token came straight from
 * the authorization server over TLS and is used solely to label the
 * account, not to authorize anything. Returns undefined rather than
 * throwing on any malformed input — a caller without an account id can
 * still function for flows that do not require the header.
 */
export function accountIdFromIdToken(
  idToken: string | undefined,
): string | undefined {
  if (idToken === undefined) return undefined;
  const payload = idToken.split(".")[1];
  if (payload === undefined) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    // report-error-ignore: a malformed id_token degrades to "no account id"
    // by contract; the caller path must keep functioning for flows that
    // never need the chatgpt-account-id header.
    return undefined;
  }
  const parsed = IdTokenClaims(claims);
  if (parsed instanceof type.errors) return undefined;
  return (
    parsed.chatgpt_account_id ??
    parsed["https://api.openai.com/auth"]?.chatgpt_account_id
  );
}

/** Maps a raw token endpoint response onto {@link CodexTokens}, decoding the account id from `id_token`. */
export function codexTokensFromResponse(
  response: TokenResponse,
  now: number,
  previousRefresh?: string,
): CodexTokens {
  const base = baseTokensFromResponse(response, now, previousRefresh);
  const accountId = accountIdFromIdToken(response.id_token);
  return {
    ...base,
    ...(accountId !== undefined ? { accountId } : {}),
  };
}

/** Exchanges an authorization code for {@link CodexTokens}. */
export async function exchangeCodexCode(
  code: string,
  verifier: string,
  now: number,
  fetchImpl: FetchLike = fetch,
): Promise<CodexTokens> {
  return codexTokensFromResponse(
    await exchangeSharedCode(codexOAuthConfig, code, verifier, fetchImpl),
    now,
  );
}

/**
 * Refreshes a Codex access token, carrying the prior refresh token forward
 * when the response omits it. A refresh response frequently omits
 * `id_token` entirely, which would otherwise drop `chatgpt-account-id` from
 * every request after the first refresh — the caller's `previous` tokens
 * supply the account id to carry forward in that case.
 */
export async function refreshCodexTokens(
  refreshToken: string,
  now: number,
  previous: CodexTokens,
  fetchImpl: FetchLike = fetch,
): Promise<CodexTokens> {
  const refreshed = codexTokensFromResponse(
    await refreshTokenRequest(codexOAuthConfig, refreshToken, fetchImpl),
    now,
    refreshToken,
  );
  return {
    ...refreshed,
    ...(refreshed.accountId === undefined && previous.accountId !== undefined
      ? { accountId: previous.accountId }
      : {}),
  };
}
