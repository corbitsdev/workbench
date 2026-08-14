// The OpenRouter PKCE connect mechanics moved to `@workbench/connections`
// (CL-6028's OAuth route factory generalized both this and Hugging
// Face's flow) — re-exported from here so nothing outside this package
// that still imports `./openrouter-connect` needs to change.
export {
  createConnectStateStore,
  generatePKCEPair,
  s256Challenge,
  type ConnectStateStore,
  type PKCEPair,
  OPENROUTER_CONNECT_STATE_TTL_MS as CONNECT_STATE_TTL_MS,
  exchangeCodeForKey,
  OPENROUTER_AUTH_URL,
  OPENROUTER_KEY_EXCHANGE_URL,
  type ExchangeCodeForKeyArgs,
  type OpenRouterExchangeFetch as ExchangeFetch,
  type OpenRouterExchangeResult as ExchangeResult,
} from "@workbench/connections";
