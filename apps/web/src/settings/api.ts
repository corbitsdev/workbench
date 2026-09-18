// Workbench settings and bench membership listings aren't reimplemented
// here — they come straight from `@/chat` and `@/bench`.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { TenantResponse, UserProfile } from "@intx/types";
import { UnauthenticatedError } from "@/lib/api-query";

export type Bench = typeof TenantResponse.infer;
export type Account = typeof UserProfile.infer;

export class SettingsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(path: string, schema: Validator<T>, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new SettingsApiError(cause instanceof Error ? cause.message : String(cause));
  }
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    throw new SettingsApiError(`The hub answered ${response.status} for ${path}.`, response.status);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new SettingsApiError(`Unexpected response shape from ${path}: ${parsed.summary}`);
  }
  return parsed;
}

export function getAccount(): Promise<Account> {
  return request("/api/me", UserProfile);
}

export function renameBench(tenantId: string, name: string): Promise<Bench> {
  return request(`/api/tenants/${tenantId}`, TenantResponse, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}
