// The hub's native HTTP API as a typed client: authenticate, sign in,
// and call any route with a validated response.

export type { ApiCall, ApiResult, Session } from "./hub";
export { authenticate, createHubAPI, parseAs, signIn } from "./hub";
export {
  HubApiError,
  isHubApiError,
  isSidecarUnavailableError,
  SidecarUnavailableError,
} from "./errors";
export { cookiesFromHeader } from "./cookies";
