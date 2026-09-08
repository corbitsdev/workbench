export const XAI_PROVIDER = "xai";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

const XAI_ISSUER = "https://auth.x.ai";
export const XAI_AUTHORIZE_URL = `${XAI_ISSUER}/oauth2/authorize`;
export const XAI_TOKEN_URL = `${XAI_ISSUER}/oauth2/token`;

const XAI_CALLBACK_PORT = 1456;
const XAI_CALLBACK_PATH = "/callback";
export const XAI_REDIRECT_URI = `http://127.0.0.1:${String(XAI_CALLBACK_PORT)}${XAI_CALLBACK_PATH}`;

export const XAI_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
] as const;

// grok-cli OAuth tokens are NOT accepted by api.x.ai (that endpoint expects an
// API key). They authenticate only against the CLI chat proxy below, which
// speaks the OpenAI Responses API.
export const XAI_OAUTH_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/** Base URL for a plain xAI API key credential (not an OAuth token). */
export const XAI_API_KEY_BASE_URL = "https://api.x.ai/v1";

// Grok-cli OAuth credentials only accept model ids the CLI chat proxy serves;
// keep the catalog aligned with the CLI's own listing.
export const XAI_DEFAULT_MODELS = [
  "grok-4.5",
  "grok-4.6",
  "grok-composer-2.5-fast",
] as const;

export const XAI_RESPONSES_PATH = "/responses";

export const XAI_CLIENT_IDENTIFIER = "grok-shell";
export const XAI_CLIENT_VERSION = "0.2.93";
export const XAI_USER_AGENT = `grok-shell/${XAI_CLIENT_VERSION} (macos; aarch64)`;

// xAI issues ~1-hour access tokens; a host calling @corbits/oauth-core's
// createTokenSession should refresh this far ahead of expiry so a
// freshly-loaded token is never immediately stale.
export const XAI_REFRESH_SKEW_MS = 5 * 60 * 1000;

// Bounds the token endpoint request. Refresh can run on the inference send
// path before any inactivity/total timer is armed, so a stalled token
// endpoint must abort rather than hang the caller at turn 0.
export const XAI_TOKEN_TIMEOUT_MS = 15_000;

/** `InferenceOptions.providerOptions` key carrying the resolved xAI user id. */
export const XAI_USER_ID_OPTION = "xaiUserId";

/** `InferenceOptions.providerOptions` key carrying the inference session id. */
export const XAI_SESSION_ID_OPTION = "xaiSessionId";

/** `InferenceOptions.providerOptions` key carrying the reasoning effort. */
export const XAI_REASONING_EFFORT_OPTION = "xaiReasoningEffort";
