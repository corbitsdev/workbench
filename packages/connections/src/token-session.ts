// Serving-time token session over a credential row (CL-7505).
//
// Inference `oauth_token` credentials go stale mid-use: the only refresh
// the hub ran before CL-7505 was the background MCP expiry sweep, and a
// still-valid-at-connect access token expires while a run is serving.
// This module adapts the vendored `@corbits/oauth-core` token session
// (`createTokenSession` — skew-aware expiry, in-process coalescing of
// concurrent refreshes) onto the shape the hub actually stores: the
// `credential` row's `secret` / `refreshSecret` / `expiresAt` columns.
//
// The refresh grant itself is pluggable — the hub supplies the grant per
// credential class (the MCP `refreshMcpOAuthTokens` flow is the first
// implementation), this module only decides WHEN a row needs refreshing
// and folds the result back through `updateTokens`. Failure never throws:
// the caller gets `{ ok: false, reauthRequired: true }` and owns marking
// the credential re-auth-required. An `api_key` (or any non-oauth_token)
// row takes the exact pass-through path it always took — no refresh
// machinery touches it.
import {
  createTokenSession,
  type BaseTokens,
  OAuthProfileNotFoundError,
  OAuthRefreshFailedError,
} from "@corbits/oauth-core";
import { reportError } from "@corbits/error-sink";

/** The slice of the credential row the token session reads and writes. */
export type CredentialTokenRow = {
  readonly id: string;
  readonly type: string;
  readonly secret: string;
  readonly refreshSecret: string | null;
  readonly expiresAt: Date | null;
};

/** The fresh token pair a refresh grant produced for a credential. */
export type RefreshedTokens = {
  readonly secret: string;
  /** Omitted when the grant carried the prior refresh token forward. */
  readonly refreshSecret?: string;
  readonly expiresAt: Date;
};

export type RefreshGrant = (
  credential: CredentialTokenRow,
) => Promise<RefreshedTokens>;

export type CredentialTokenSessionDeps = {
  loadProfile: (credentialId: string) => Promise<CredentialTokenRow | null>;
  updateTokens: (
    credentialId: string,
    tokens: RefreshedTokens,
  ) => Promise<void>;
  refresh: RefreshGrant;
  /** Epoch-ms clock; defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
  /** How far ahead of `expiresAt` a token counts as expiring.
   * Defaults to 60s — one dial round-trip must still land on a live
   * token after the check. */
  skewLeadMs?: number;
};

export type TokenResolution =
  | { readonly ok: true; readonly secret: string; readonly refreshed: boolean }
  | {
      readonly ok: false;
      /** True when the row is past saving: the grant failed or the
       * credential has no usable refresh secret. The caller should mark
       * the credential re-auth-required rather than retry. */
      readonly reauthRequired: boolean;
      readonly message: string;
    };

const DEFAULT_SKEW_LEAD_MS = 60 * 1000;

export function createCredentialTokenSession(
  deps: CredentialTokenSessionDeps,
): { getValidToken(credentialId: string): Promise<TokenResolution> } {
  const now = deps.now ?? Date.now;
  const skewLeadMs = deps.skewLeadMs ?? DEFAULT_SKEW_LEAD_MS;

  // The vendored session keys its in-flight refresh map by profile name —
  // the credential id, so concurrent calls for one credential coalesce
  // into exactly one grant while different credentials refresh in
  // parallel.
  const sessions = new Map<
    string,
    ReturnType<typeof createTokenSession<BaseTokens, string>>
  >();

  function sessionFor(credential: CredentialTokenRow) {
    const existing = sessions.get(credential.id);
    if (existing !== undefined) return existing;
    const session = createTokenSession<BaseTokens, string>({
      skewMs: skewLeadMs,
      loadProfile: async (id) => {
        const row = await deps.loadProfile(id);
        if (row === null || row.refreshSecret === null) return undefined;
        const expiresAt = row.expiresAt?.getTime();
        return {
          tokens: {
            access: row.secret,
            refresh: row.refreshSecret,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          },
        };
      },
      updateTokens: async (id, tokens) => {
        // A grant that carried the prior refresh token forward re-sends
        // it; don't rewrite the column when nothing changed.
        const prior = await deps.loadProfile(id);
        const changedRefresh =
          prior === null ||
          tokens.refresh === undefined ||
          tokens.refresh !== prior.refreshSecret;
        await deps.updateTokens(id, {
          secret: tokens.access,
          ...(tokens.refresh !== undefined && changedRefresh
            ? { refreshSecret: tokens.refresh }
            : {}),
          expiresAt: new Date(tokens.expiresAt ?? now() + skewLeadMs),
        });
      },
      refreshTokens: async (refreshToken, at) => {
        // The grant decides how to use the refresh token; the session
        // only guarantees it runs at most once per expiry window.
        void refreshToken;
        void at;
        const refreshed = await deps.refresh(credential);
        return {
          access: refreshed.secret,
          refresh: refreshed.refreshSecret ?? refreshToken,
          expiresAt: refreshed.expiresAt.getTime(),
        };
      },
      toAccess: (tokens) => tokens.access,
    });
    sessions.set(credential.id, session);
    return session;
  }

  return {
    async getValidToken(credentialId: string): Promise<TokenResolution> {
      const row = await deps.loadProfile(credentialId);
      if (row === null) {
        return {
          ok: false,
          reauthRequired: false,
          message: `credential ${credentialId} not found`,
        };
      }
      if (row.type !== "oauth_token") {
        return { ok: true, secret: row.secret, refreshed: false };
      }
      if (row.refreshSecret === null) {
        const expired =
          row.expiresAt !== null &&
          now() >= row.expiresAt.getTime() - skewLeadMs;
        if (!expired) {
          return { ok: true, secret: row.secret, refreshed: false };
        }
        return {
          ok: false,
          reauthRequired: true,
          message: `credential ${credentialId} is expired and has no refresh secret — reconnect required`,
        };
      }
      try {
        const secret = await sessionFor(row).getValidToken(credentialId, now());
        return { ok: true, secret, refreshed: secret !== row.secret };
      } catch (cause) {
        reportError(cause, {
          operation: "credential_token_refresh",
          extra: { credentialId },
        });
        const message =
          cause instanceof OAuthRefreshFailedError ||
          cause instanceof OAuthProfileNotFoundError
            ? cause.cause instanceof Error
              ? cause.cause.message
              : cause.message
            : cause instanceof Error
              ? cause.message
              : String(cause);
        return { ok: false, reauthRequired: true, message };
      }
    },
  };
}
