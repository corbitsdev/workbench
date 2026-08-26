// The MCP-server connector's OAuth half (CL-6152): a real
// `OAuthClientProvider` for the official `@modelcontextprotocol/sdk`
// client's own `auth()` orchestrator, rather than a hand-rolled
// authorize/token exchange. `auth()` already does everything the MCP
// authorization spec asks for -- RFC 9728 protected-resource discovery,
// RFC 8414/OIDC authorization-server discovery, RFC 7591 dynamic client
// registration when the server supports it, PKCE, and the token
// exchange -- this module only supplies the session storage `auth()`
// needs between the `/start` request (which redirects the browser away)
// and the `/callback` request (a different HTTP request, on a different
// process tick, that must pick up exactly where `/start` left off).
//
// `McpOAuthSession` is that storage: a plain mutable record `mcp-oauth-
// routes.ts` seals into the same short-TTL, AEAD-encrypted cookie
// `./pkce.ts`'s `createConnectStateStore` already uses for the fixed-
// registry OAuth connectors, so a state minted moments before a hub
// restart survives it exactly like `./oauth-routes.ts`'s flows do.
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export type McpOAuthSession = {
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  /** The CSRF-binding OAuth `state` value: minted by the `/start` route
   * before `auth()` runs (so it's known before `redirectToAuthorization`
   * fires) and sealed into the same cookie as `codeVerifier`. `auth()`
   * reads it through `state()` below and appends it to the authorize URL
   * it sends the provider; `/callback` re-derives it from the cookie and
   * requires the provider's `?state=` to match exactly -- CSRF protection
   * that was previously minted (`nonce`) but never actually sent to the
   * provider or checked back, so every connect silently omitted `state`. */
  state?: string;
  tokens?: OAuthTokens;
};

/**
 * Builds a fresh, in-memory `OAuthClientProvider` bound to one connect
 * attempt's `session`. The caller reads/writes `session` across the
 * `/start` → `/callback` boundary (serializing it into the sealed
 * cookie); this provider itself holds no state of its own beyond that
 * one object, so a fresh provider is cheap to build per request.
 */
export function createMcpOAuthProvider(args: {
  readonly callbackUrl: string;
  readonly clientName: string;
  readonly session: McpOAuthSession;
  readonly scope?: string;
}): OAuthClientProvider {
  const { session } = args;
  let authorizationUrl: URL | undefined;

  return {
    get redirectUrl(): string {
      return args.callbackUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: args.clientName,
        redirect_uris: [args.callbackUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(args.scope === undefined ? {} : { scope: args.scope }),
      };
    },
    state(): string {
      if (session.state === undefined) {
        throw new Error("No OAuth state minted for this MCP OAuth session");
      }
      return session.state;
    },
    clientInformation(): OAuthClientInformationMixed | undefined {
      return session.clientInformation;
    },
    saveClientInformation(info: OAuthClientInformationMixed): void {
      session.clientInformation = info;
    },
    tokens(): OAuthTokens | undefined {
      return session.tokens;
    },
    saveTokens(tokens: OAuthTokens): void {
      session.tokens = tokens;
    },
    redirectToAuthorization(url: URL): void {
      authorizationUrl = url;
    },
    saveCodeVerifier(codeVerifier: string): void {
      session.codeVerifier = codeVerifier;
    },
    codeVerifier(): string {
      if (session.codeVerifier === undefined) {
        throw new Error(
          "No PKCE code verifier saved for this MCP OAuth session",
        );
      }
      return session.codeVerifier;
    },
    /** Not part of `OAuthClientProvider` -- `mcp-oauth-routes.ts` reads
     * this off the concrete provider object after calling `auth()`, the
     * only way to recover the URL `redirectToAuthorization` captured
     * since that method itself returns nothing. */
    get capturedAuthorizationUrl(): URL | undefined {
      return authorizationUrl;
    },
  } as OAuthClientProvider & { readonly capturedAuthorizationUrl?: URL };
}

export type McpOAuthRefreshResult =
  | { readonly ok: true; readonly tokens: OAuthTokens }
  | { readonly ok: false; readonly message: string };

/**
 * CL-6207: re-invokes `auth()` with a session pre-loaded with the stored
 * token pair (and the client this workbench registered at connect time,
 * when known) so a stored `refresh_token` takes `auth()`'s own refresh
 * branch instead of falling through to a fresh interactive
 * authorization. Never redirects a human -- a refresh that can't
 * complete non-interactively (revoked client, no refresh grant) comes
 * back as `{ ok: false }`, not a `REDIRECT` this caller has nowhere to
 * send; `apps/hub`'s credential-expiry sweep is the only caller today.
 */
export async function refreshMcpOAuthTokens(args: {
  readonly serverUrl: string;
  readonly tokens: OAuthTokens;
  readonly clientInformation?: OAuthClientInformationMixed;
  readonly callbackUrl: string;
  readonly clientName: string;
}): Promise<McpOAuthRefreshResult> {
  const session: McpOAuthSession = {
    tokens: args.tokens,
    ...(args.clientInformation !== undefined
      ? { clientInformation: args.clientInformation }
      : {}),
  };
  const provider = createMcpOAuthProvider({
    callbackUrl: args.callbackUrl,
    clientName: args.clientName,
    session,
  });

  let result: Awaited<ReturnType<typeof auth>>;
  try {
    result = await auth(provider, { serverUrl: args.serverUrl });
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (result !== "AUTHORIZED" || session.tokens === undefined) {
    return {
      ok: false,
      message:
        "the authorization server required a new interactive authorization instead of refreshing",
    };
  }
  return { ok: true, tokens: session.tokens };
}
