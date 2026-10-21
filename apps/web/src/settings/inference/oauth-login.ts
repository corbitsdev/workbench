// The browser's half of a hub-hosted OAuth login (`@corbits/oauth-core/hub`).
// The hub runs the loopback PKCE flow and stores the tokens itself, so
// nothing here ever holds a token — only a login id and, at the end, the id
// of the credential the hub wrote.

import { type } from "arktype";

import { apiRequest } from "../api-request";
import { InferenceSettingsApiError, type FetchImpl } from "./api";

const StartedLogin = type({ loginId: "string", authorizeUrl: "string" });
export type StartedLogin = typeof StartedLogin.infer;

const LoginState = type({ status: "'pending'" })
  .or({ status: "'completed'", credentialId: "string" })
  .or({ status: "'failed'", message: "string" })
  .or({ status: "'cancelled'" });
export type LoginState = typeof LoginState.infer;

/** Starts a login for `provider`, filing the credential it will mint under
 * `providerId`/`credentialName`. Returns the URL to send the person to. */
export function startProviderLogin(
  tenantId: string,
  input: {
    readonly provider: string;
    readonly providerId: string;
    readonly credentialName: string;
  },
  fetchImpl: FetchImpl = fetch,
): Promise<StartedLogin> {
  return apiRequest(
    `/api/tenants/${tenantId}/oauth-logins`,
    StartedLogin,
    "starting the sign-in",
    InferenceSettingsApiError,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    fetchImpl,
  );
}

export function readProviderLogin(
  tenantId: string,
  loginId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<LoginState> {
  return apiRequest(
    `/api/tenants/${tenantId}/oauth-logins/${loginId}`,
    LoginState,
    "checking the sign-in",
    InferenceSettingsApiError,
    undefined,
    fetchImpl,
  );
}

export async function cancelProviderLogin(
  tenantId: string,
  loginId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<void> {
  await fetchImpl(`/api/tenants/${tenantId}/oauth-logins/${loginId}`, { method: "DELETE" });
}
