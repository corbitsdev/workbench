// Plugins section seam onto the connector-registry routes
// (`/api/tenants/:tenantId/connections/:connectorId/*`,
// `@workbench/connections`'s route factory) and the native credential
// delete route. Same shape as `@corbits/settings-ui`'s own
// connections-api.ts — chat-ui cannot import that package (settings-ui
// depends on chat-ui, not the other way around), so this is its own
// small client against the same routes rather than a shared one.

import { type } from "arktype";
import { UnauthenticatedError } from "@corbits/api-query";

export class PluginsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const TestResult = type({ ok: "true" });
const CompleteResult = type({ credentialId: "string", status: "'active'" });

async function request<T>(
  path: string,
  schema: (data: unknown) => T | type.errors,
  verb: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new PluginsApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const envelope = type({ error: { message: "string" } })(body);
    throw new PluginsApiError(
      envelope instanceof type.errors
        ? `The server answered ${response.status} while ${verb}.`
        : envelope.error.message,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new PluginsApiError(
      `Unexpected response shape while ${verb}: ${parsed.summary}`,
    );
  }
  return parsed;
}

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
    if (cause instanceof PluginsApiError && cause.status === 422) {
      return { ok: false, message: cause.message };
    }
    throw cause;
  }
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

export function removeWorkbenchCredential(
  tenantId: string,
  credentialId: string,
): Promise<void> {
  return request<void>(
    `/api/tenants/${tenantId}/credentials/${credentialId}`,
    (data) => data as void,
    "removing that connection",
    { method: "DELETE" },
  );
}
