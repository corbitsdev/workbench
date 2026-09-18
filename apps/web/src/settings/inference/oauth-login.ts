// The browser's half of a hub-hosted OAuth login (`@corbits/oauth-core/hub`).
// The hub runs the loopback PKCE flow and stores the tokens itself, so
// nothing here ever holds a token — only a login id and, at the end, the id
// of the credential the hub wrote.

import { type } from "arktype";

import { InferenceSettingsApiError, type FetchImpl } from "./api";

const StartedLogin = type({ loginId: "string", authorizeUrl: "string" });
export type StartedLogin = typeof StartedLogin.infer;

const LoginState = type({ status: "'pending'" })
  .or({ status: "'completed'", credentialId: "string" })
  .or({ status: "'failed'", message: "string" })
  .or({ status: "'cancelled'" });
export type LoginState = typeof LoginState.infer;

async function parsed<T>(
  response: Response,
  schema: (data: unknown) => T | type.errors,
  verb: string,
): Promise<T> {
  if (!response.ok) {
    throw new InferenceSettingsApiError(
      `The server answered ${String(response.status)} while ${verb}.`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const result = schema(body);
  if (result instanceof type.errors) {
    throw new InferenceSettingsApiError(
      `Unexpected response shape while ${verb}: ${result.summary}`,
    );
  }
  return result;
}

/** Starts a login for `provider`, filing the credential it will mint under
 * `providerId`/`credentialName`. Returns the URL to send the person to. */
export async function startProviderLogin(
  tenantId: string,
  input: {
    readonly provider: string;
    readonly providerId: string;
    readonly credentialName: string;
  },
  fetchImpl: FetchImpl = fetch,
): Promise<StartedLogin> {
  return parsed(
    await fetchImpl(`/api/tenants/${tenantId}/oauth-logins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    StartedLogin,
    "starting the sign-in",
  );
}

export async function readProviderLogin(
  tenantId: string,
  loginId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<LoginState> {
  return parsed(
    await fetchImpl(`/api/tenants/${tenantId}/oauth-logins/${loginId}`),
    LoginState,
    "checking the sign-in",
  );
}

export async function cancelProviderLogin(
  tenantId: string,
  loginId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<void> {
  await fetchImpl(`/api/tenants/${tenantId}/oauth-logins/${loginId}`, { method: "DELETE" });
}
