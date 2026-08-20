// Browser client for @corbits/preferences' tenant-scoped routes. Apps stay
// generic (AGENTS.md): the fetch/parse logic for hitting
// `/api/tenants/:id/preferences` is domain logic that lives here, not in
// apps/web.
import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { UnauthenticatedError } from "@corbits/api-query/envelope";

const PreferencesResponse = type({
  preferences: "Record<string, unknown>",
});

export class PreferencesApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

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
    throw new PreferencesApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    throw new PreferencesApiError(
      `The hub answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new PreferencesApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function getPreferences(
  tenantId: string,
): Promise<Record<string, unknown>> {
  return request(
    `/api/tenants/${tenantId}/preferences`,
    PreferencesResponse,
  ).then((r) => r.preferences);
}

export function patchPreferences(
  tenantId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return request(`/api/tenants/${tenantId}/preferences`, PreferencesResponse, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }).then((r) => r.preferences);
}
