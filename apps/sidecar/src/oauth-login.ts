// Sidecar-hosted loopback OAuth login for the pinned-port providers
// (CL-7508). The authorization servers for Codex ("Login with ChatGPT") and
// xai-oauth (Grok CLI) only accept the fixed loopback redirect URIs their
// own CLIs register — `http://localhost:1455/auth/callback` and
// `http://127.0.0.1:1456/callback` — so the callback listener must bind
// exactly those ports on the machine the user is browsing from. That
// machine is the sidecar's host, which is why the login runs here, not in
// the hub: the hub threads an `oauth.login.start` frame over the ws
// channel, this service stages the login (PKCE pair, callback server,
// code exchange) sidecar-side, and only the finished tokens cross the
// wire — the PKCE verifier never leaves this process, and the browser is
// never opened sidecar-side (the hub ships the authorize URL to the web
// UI for navigation).
import {
  buildAuthorizeUrl,
  startCallbackServer,
  startOAuthLogin,
  type BaseTokens,
  type CallbackServerConfig,
  type FetchLike,
  type OAuthClientConfig,
} from "@corbits/oauth-core";
import {
  codexOAuthConfig,
  exchangeCodexCode,
  CODEX_REDIRECT_URI,
} from "@corbits/codex-provider";
import {
  exchangeXaiCode,
  xaiOAuthConfig,
  XAI_REDIRECT_URI,
} from "@corbits/xai-provider";

/** The sidecar-hosted login outcome: the shape `@intx/types`'s
 * `OAuthLoginTokens` wire arm carries. */
export type StagedLoginTokens = BaseTokens & {
  /** The issuer's id_token, when it issues one (xai-oauth). */
  idToken?: string;
  /** id_token-derived account label (codex: `chatgpt_account_id`). */
  accountId?: string;
};

export type OAuthLoopbackLoginService = {
  start: (connectorId: "codex" | "xai-oauth") => Promise<{
    authorizeUrl: string;
    completed: Promise<StagedLoginTokens>;
    /** Closes the callback server and abandons the staged login. */
    cancel: () => void;
  }>;
};

// The pins this service exists to enforce. A redirect URI whose port is not
// one of these is a manifest drift, not a cue to rebind dynamically.
const CODEX_PINNED_PORT = 1455;
const XAI_PINNED_PORT = 1456;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Builds the callback-server config from a provider's registered redirect
 * URI, asserting the loopback + pinned-port contract up front: a bind
 * failure later is genuinely "port already in use", never "we drifted onto
 * some other port". */
function callbackConfig(
  redirectUri: string,
  pinnedPort: number,
): CallbackServerConfig {
  const url = new URL(redirectUri);
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
    throw new Error(
      `${redirectUri} is not a loopback http redirect; refusing to host a login for it`,
    );
  }
  const port = Number(url.port);
  if (port !== pinnedPort) {
    throw new Error(
      `${redirectUri} is not the pinned port ${String(pinnedPort)}; the authorization server only accepts the registered redirect`,
    );
  }
  return {
    port,
    host: url.hostname,
    path: url.pathname,
    doneHtml:
      "<!doctype html><title>Connected</title><p>Login complete — you can close this window.</p>",
    failedHtml: (reason) =>
      `<!doctype html><title>Login failed</title><p>Login failed: ${reason}</p>`,
  };
}

export function createOAuthLoopbackLoginService(deps?: {
  /** Epoch-ms clock; defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
  /** HTTP client for the token exchange; defaults to `fetch`. */
  fetchImpl?: FetchLike;
}): OAuthLoopbackLoginService {
  const now = deps?.now ?? Date.now;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  // Browser-open suppression is deliberate: the sidecar runs on the user's
  // machine but the hub owns navigation — it ships `authorizeUrl` to the web
  // UI, and a sidecar-side `open` would race it with a second consent page.
  const suppressedOpen = () => undefined;

  const connectors = {
    codex: {
      callback: callbackConfig(CODEX_REDIRECT_URI, CODEX_PINNED_PORT),
      oauthConfig: codexOAuthConfig satisfies OAuthClientConfig,
      exchange: (code: string, verifier: string, at: number) =>
        exchangeCodexCode(code, verifier, at, fetchImpl),
    },
    "xai-oauth": {
      callback: callbackConfig(XAI_REDIRECT_URI, XAI_PINNED_PORT),
      oauthConfig: xaiOAuthConfig,
      exchange: (code: string, verifier: string, at: number) =>
        exchangeXaiCode(code, verifier, at, fetchImpl),
    },
  } as const;

  return {
    async start(connectorId) {
      const connector = connectors[connectorId];
      const handle = await startOAuthLogin(
        { profile: connectorId, signal: new AbortController().signal, now },
        {
          startCallbackServer: (state) =>
            startCallbackServer(state, connector.callback),
          buildAuthorizeUrl: (pkce, state) =>
            buildAuthorizeUrl(connector.oauthConfig, pkce, state),
          exchangeCode: (code, verifier, at) =>
            connector.exchange(code, verifier, at),
          // Persistence is the hub's job: the connect pipeline stores the
          // credential row, so the staged `commit` here is a no-op that
          // exists only to satisfy the oauth-core login contract.
          saveProfile: async () => undefined,
          // A no-op keeps navigation authority with the hub: the web UI
          // opens the authorize URL the hub ships it, and a sidecar-side
          // opener would race it with a second consent page.
          openInBrowser: suppressedOpen,
        },
      );
      return {
        authorizeUrl: handle.authorizeUrl,
        completed: handle.completed.then((staged) => staged.profile.tokens),
        cancel: () => {
          handle.cancel();
        },
      };
    },
  };
}
