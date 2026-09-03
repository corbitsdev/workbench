// The Hugging Face PKCE connect mechanics moved to
// `@corbits/connections` (CL-6028's OAuth route factory generalized
// both this and OpenRouter's flow) — re-exported from here so nothing
// outside this package that still imports `./huggingface-connect` needs
// to change.
export {
  createConnectStateStore,
  generatePKCEPair,
  type ConnectStateStore,
  type PKCEPair,
  HUGGINGFACE_CONNECT_STATE_TTL_MS as CONNECT_STATE_TTL_MS,
  exchangeCodeForToken,
  HUGGINGFACE_AUTHORIZE_URL,
  HUGGINGFACE_SCOPE,
  HUGGINGFACE_TOKEN_URL,
  type ExchangeCodeForTokenArgs,
  type HuggingFaceExchangeFetch as ExchangeFetch,
  type HuggingFaceExchangeResult as ExchangeResult,
} from "@corbits/connections";
