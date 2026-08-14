// The library entry for `@workbench/connections`: PKCE/state primitives
// shared by every OAuth connect flow, the connector descriptor shape and
// registry (also reachable browser-side through the lighter
// `./registry` subpath — see that file's header comment), the
// tenant-scoped route factory that tests and stores an api-key
// connector's credential, the oauth-pkce/oauth-code route factory, and
// the two providers' connect mechanics (OpenRouter, Hugging Face) that
// factory drives.
export {
  createConnectStateStore,
  generatePKCEPair,
  s256Challenge,
  type ConnectStateStore,
  type PKCEPair,
} from "./pkce";
export type {
  ConnectorAuthKind,
  ConnectorDescriptor,
  ConnectorOAuthConfig,
  OAuthExchangeResult,
} from "./descriptor";
export { CONNECTOR_REGISTRY, connectorDescriptors } from "./registry";
export {
  testExaCredential,
  testGitHubCredential,
  testGranolaCredential,
  testLinearCredential,
  testScrapeCreatorsCredential,
} from "./probes";
export {
  createConnectionRoutes,
  type CreateConnectionRoutesDeps,
} from "./routes";
export {
  createOAuthConnectRoutes,
  DEFAULT_RETURN_PATH_ALLOWLIST,
  sanitizeReturnPath,
  type CreateOAuthConnectRoutesDeps,
  type OAuthStoreOutcome,
} from "./oauth-routes";
export {
  CONNECT_STATE_TTL_MS as OPENROUTER_CONNECT_STATE_TTL_MS,
  exchangeCodeForKey,
  OPENROUTER_AUTH_URL,
  OPENROUTER_KEY_EXCHANGE_URL,
  type ExchangeCodeForKeyArgs,
  type ExchangeFetch as OpenRouterExchangeFetch,
  type ExchangeResult as OpenRouterExchangeResult,
} from "./openrouter-connect";
export {
  CONNECT_STATE_TTL_MS as HUGGINGFACE_CONNECT_STATE_TTL_MS,
  exchangeCodeForToken,
  HUGGINGFACE_AUTHORIZE_URL,
  HUGGINGFACE_SCOPE,
  HUGGINGFACE_TOKEN_URL,
  type ExchangeCodeForTokenArgs,
  type ExchangeFetch as HuggingFaceExchangeFetch,
  type ExchangeResult as HuggingFaceExchangeResult,
} from "./huggingface-connect";
