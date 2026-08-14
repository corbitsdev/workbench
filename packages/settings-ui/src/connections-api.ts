// Connections section seam to the connector-registry routes
// (`/api/tenants/:tenantId/connections/:connectorId/*`, `@workbench/connections`'s
// route factory). `credentials-api.ts`-shaped: same fetch wrapper, same
// error class convention, arktype at the trust boundary.

import { type } from "arktype";
import type { ArkErrors } from "arktype";

export class ConnectionsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const ErrorEnvelope = type({
  error: {
    code: "string",
    message: "string",
  },
});

const TestResult = type({ ok: "true" });

const CompleteResult = type({
  credentialId: "string",
  status: "'active'",
});

const OAuthConfiguredResult = type("Record<string, boolean>");

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(
  path: string,
  schema: Validator<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ConnectionsApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new ConnectionsApiError(`Not signed in for ${path}.`, 401);
  }
  if (response.status === 403) {
    throw new ConnectionsApiError(`Not permitted to view ${path}.`, 403);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const envelope = ErrorEnvelope(body);
    const message =
      envelope instanceof type.errors
        ? `The hub answered ${response.status} for ${path}.`
        : envelope.error.message;
    throw new ConnectionsApiError(message, response.status);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ConnectionsApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
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
    { method: "POST", body: JSON.stringify({ apiKey }) },
  );
}
