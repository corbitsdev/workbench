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
  XAI_AUTHORIZE_URL,
  XAI_CLIENT_ID,
  XAI_REDIRECT_URI,
  XAI_SCOPES,
  XAI_TOKEN_TIMEOUT_MS,
  XAI_TOKEN_URL,
} from "./constants";

/** Tokens issued by xAI's OAuth server: the shared base shape plus an `idToken`. */
export type XaiTokens = BaseTokens & { idToken?: string };

/**
 * The PKCE OAuth client config for xAI/Grok login. Pass this to
 * `@corbits/oauth-core`'s `buildAuthorizeUrl`, `exchangeCode`, and
 * `refreshTokenRequest`.
 */
export const xaiOAuthConfig: OAuthClientConfig = {
  clientId: XAI_CLIENT_ID,
  authorizeUrl: XAI_AUTHORIZE_URL,
  tokenUrl: XAI_TOKEN_URL,
  redirectUri: XAI_REDIRECT_URI,
  scopes: XAI_SCOPES,
  tokenTimeoutMs: XAI_TOKEN_TIMEOUT_MS,
};

/** Maps a raw token endpoint response onto {@link XaiTokens}, carrying `id_token` through. */
export function xaiTokensFromResponse(
  response: TokenResponse,
  now: number,
  previousRefresh?: string,
): XaiTokens {
  const base = baseTokensFromResponse(response, now, previousRefresh);
  return {
    ...base,
    ...(response.id_token !== undefined ? { idToken: response.id_token } : {}),
  };
}

/** Exchanges an authorization code for {@link XaiTokens}. */
export async function exchangeXaiCode(
  code: string,
  verifier: string,
  now: number,
  fetchImpl: FetchLike = fetch,
): Promise<XaiTokens> {
  return xaiTokensFromResponse(
    await exchangeSharedCode(xaiOAuthConfig, code, verifier, fetchImpl),
    now,
  );
}

/** Refreshes an xAI access token, carrying the prior refresh token forward if omitted. */
export async function refreshXaiTokens(
  refreshToken: string,
  now: number,
  fetchImpl: FetchLike = fetch,
): Promise<XaiTokens> {
  return xaiTokensFromResponse(
    await refreshTokenRequest(xaiOAuthConfig, refreshToken, fetchImpl),
    now,
    refreshToken,
  );
}

const AccessTokenPayload = type({ "sub?": "string" });

/**
 * Decodes the xAI user id out of an access token's JWT `sub` claim. The
 * proxy wants the caller's user id in a request header; the access token
 * already carries it rather than requiring a separate lookup. The signature
 * is never verified — this only labels a header value with the id the
 * issuer already vouched for by handing us the token, it never authorizes
 * anything on its own.
 */
export function xaiUserIdFromAccessToken(access: string): string | undefined {
  const segment = access.split(".")[1];
  if (segment === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    // report-error-ignore: a truncated or non-JWT access token degrades to
    // "no user id" by contract; the header is a label, not an authorization
    // decision, and a throw would abort a turn that can still authenticate
    // via Bearer.
    return undefined;
  }
  const payload = AccessTokenPayload(decoded);
  return payload instanceof type.errors ? undefined : payload.sub;
}
