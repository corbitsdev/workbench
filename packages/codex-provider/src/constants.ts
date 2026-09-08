// OAuth and wire constants for OpenAI Codex's "Login with ChatGPT" flow.
// These values mirror the public Codex CLI client: the client id is a
// public identifier (not a secret), and the endpoints belong to OpenAI's
// consumer authorization server at auth.openai.com — distinct from the
// platform API key system at platform.openai.com. A successful login yields
// a token billed against the user's ChatGPT subscription, not per-token API
// usage.

// Interchange provider key this package registers its adapter under.
export const CODEX_PROVIDER = "codex";

// Public client identifier for the Codex CLI authorization flow. Not a secret.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

// Token refresh can run on the inference send path before any surrounding
// timer is armed, so the request must abort rather than hang the caller if
// the endpoint stalls.
export const CODEX_TOKEN_TIMEOUT_MS = 15_000;

// The Codex CLI registers a fixed loopback redirect on port 1455 using the
// `localhost` host (not `127.0.0.1`); the authorization server only accepts
// this exact redirect_uri for this client.
const CODEX_CALLBACK_PORT = 1455;
const CODEX_CALLBACK_PATH = "/auth/callback";
export const CODEX_REDIRECT_URI = `http://localhost:${String(CODEX_CALLBACK_PORT)}${CODEX_CALLBACK_PATH}`;

// Mirrors the current Codex CLI's authorize request (codex-rs/login/src/server.rs,
// `build_authorize_url`). The two `api.connectors.*` scopes let the backend
// serve connector tools to this client; the authorization server issues them
// only to the Codex client id.
export const CODEX_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
] as const;

// The client identity the Codex backend expects on both the authorize
// request and every inference request; it is the public Codex CLI's own.
export const CODEX_ORIGINATOR = "codex_cli_rs";

// codex_cli_simplified_flow / id_token_add_organizations / originator: the
// Codex CLI's authorize request opts into a simplified consent screen, asks
// the authorization server to fold organization membership into the
// id_token, and identifies the client; the authorization server rejects the
// plain flow for this client without these three extra params.
export const CODEX_AUTHORIZE_EXTRA_PARAMS: Record<string, string> = {
  codex_cli_simplified_flow: "true",
  id_token_add_organizations: "true",
  originator: CODEX_ORIGINATOR,
};

// Inference surface reached with the subscription token. The Codex backend
// serves the OpenAI *Responses* API here, not Chat Completions, and
// requires a `chatgpt-account-id` header (see `accountIdFromIdToken`) plus
// `openai-beta: responses=experimental`.
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_RESPONSES_PATH = "/codex/responses";

// Refresh a token this many milliseconds before its stated expiry so a
// request is never sent with a token about to lapse mid-flight.
export const CODEX_REFRESH_SKEW_MS = 60_000;

// `InferenceOptions.providerOptions` key carrying the ChatGPT account id.
export const CODEX_ACCOUNT_ID_OPTION = "codexAccountId";

// `InferenceOptions.providerOptions` key carrying the inference session id.
export const CODEX_SESSION_ID_OPTION = "codexSessionId";

// `InferenceOptions.providerOptions` key carrying the reasoning effort.
export const CODEX_REASONING_EFFORT_OPTION = "codexReasoningEffort";
