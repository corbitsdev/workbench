/**
 * OpenAI Codex ("Login with ChatGPT") as an Interchange inference provider:
 * OAuth constants and token mapping for `@corbits/oauth-core`, and a
 * Responses-protocol adapter configured for Codex's ChatGPT backend over
 * `@corbits/openai-responses`. No TUI, no telemetry, no product strings
 * baked in — a host supplies its own callback server, credential storage,
 * and product identity via `CodexQuirks`.
 */

export {
  CODEX_ACCOUNT_ID_OPTION,
  CODEX_BASE_URL,
  CODEX_PROVIDER,
  CODEX_REASONING_EFFORT_OPTION,
  CODEX_REDIRECT_URI,
  CODEX_REFRESH_SKEW_MS,
  CODEX_RESPONSES_PATH,
  CODEX_SESSION_ID_OPTION,
} from "./constants";

export {
  accountIdFromIdToken,
  codexOAuthConfig,
  codexTokensFromResponse,
  exchangeCodexCode,
  refreshCodexTokens,
  type CodexTokens,
} from "./oauth";

export { wrapCodexBridgeMessage } from "./instructions";

export { CodexQuirks, CodexQuirksError, parseCodexQuirks } from "./quirks";

export { createCodexResponsesAdapter } from "./responses-adapter";

export {
  withCodexContentTypeRepair,
  type FetchLike,
} from "./content-type-repair";
