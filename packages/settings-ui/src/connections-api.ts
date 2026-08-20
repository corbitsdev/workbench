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

const CompleteResult = type({
  credentialId: "string",
  status: "'active'",
  "modelGuidance?": "string",
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

/**
 * The one connect action (CL-6377): the server proves the pasted key
 * against the connector's own probe and only stores it once that probe
 * accepts — there is no separate client-driven "test" round-trip before
 * this call. A rejected probe 422s with the probe's own message, which
 * throws `ConnectionsApiError` (status 422); the caller renders that
 * inline as the normal connect-failed state.
 */
export function completeConnectorCredential(
  tenantId: string,
  connectorId: string,
  apiKey: string,
): Promise<{
  credentialId: string;
  status: "active";
  modelGuidance?: string;
}> {
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
