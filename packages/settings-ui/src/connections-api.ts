// Connections section seam to the connector-registry routes
// (`/api/tenants/:tenantId/connections/:connectorId/*`, `@workbench/connections`'s
// route factory). `credentials-api.ts`-shaped: same fetch wrapper, same
// error class convention, arktype at the trust boundary.

import { type } from "arktype";

import { apiRequest, type Validator } from "./api-request";

export class ConnectionsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const TestResult = type({ ok: "true" });

const CompleteResult = type({
  credentialId: "string",
  status: "'active'",
});

const OAuthConfiguredResult = type("Record<string, boolean>");

function request<T>(
  path: string,
  schema: Validator<T>,
  verb: string,
  init?: RequestInit,
): Promise<T> {
  return apiRequest(path, schema, verb, ConnectionsApiError, init);
}

/**
 * Tests an api-key connector's credential without storing it. A 422 means
 * the probe rejected the key — an expected, non-exceptional outcome the
 * caller renders inline, not a transport failure — so it resolves
 * `{ ok: false, message }` instead of throwing. Every other non-2xx status
 * still throws `ConnectionsApiError`.
 */
export async function testConnectorCredential(
  tenantId: string,
  connectorId: string,
  apiKey: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await request(
      `/api/tenants/${tenantId}/connections/${connectorId}/credential/test`,
      TestResult,
      "testing that connection",
      { method: "POST", body: JSON.stringify({ apiKey }) },
    );
    return { ok: true };
  } catch (cause) {
    if (cause instanceof ConnectionsApiError && cause.status === 422) {
      return { ok: false, message: cause.message };
    }
    throw cause;
  }
}

/**
 * Which oauth-pkce/oauth-code connectors have a registered OAuth app
 * (a client id) configured, keyed by connector id — read ahead of
 * rendering a card's Connect action so an unregistered connector shows
 * the muted "Not configured" state instead of a button that would
 * round-trip into the provider's own consent screen and dead-end.
 */
export function fetchOAuthConfigured(
  tenantId: string,
): Promise<Record<string, boolean>> {
  return request(
    `/api/tenants/${tenantId}/connections/oauth-configured`,
    OAuthConfiguredResult,
    "loading connection status",
  );
}

export function completeConnectorCredential(
  tenantId: string,
  connectorId: string,
  apiKey: string,
): Promise<{ credentialId: string; status: "active" }> {
  return request(
    `/api/tenants/${tenantId}/connections/${connectorId}/complete`,
    CompleteResult,
    "saving that connection",
    { method: "POST", body: JSON.stringify({ apiKey }) },
  );
}

/**
 * Disconnects a connector through `packages/connections`' own
 * orchestrated route — never `DELETE /credentials/:id` directly. That
 * native route alone 500s for any inference-provider connector once
 * `seedCatalog` has planted a catalog provider row against the
 * credential (`model_provider.credential_id` is `ON DELETE RESTRICT`);
 * this route deletes the catalog provider first (cascading its
 * offerings), then the credential provider row (cascading its
 * credentials) — see `@workbench/connections`' `disconnectConnector` for
 * the full ordering and why (CL-6258).
 */
export function disconnectConnector(
  tenantId: string,
  connectorId: string,
): Promise<void> {
  return request<void>(
    `/api/tenants/${tenantId}/connections/${connectorId}/disconnect`,
    (data) => data as void,
    "disconnecting that connection",
    { method: "DELETE" },
  );
}
