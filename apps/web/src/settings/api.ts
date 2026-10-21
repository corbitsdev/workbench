// Workbench settings and bench membership listings aren't reimplemented
// here — they come straight from `@/chat` and `@/bench`.

import { TenantResponse, UserProfile } from "@intx/types";
import { ApiQueryError } from "@/lib/api-query";
import { apiRequest, type Validator } from "./api-request";

export type Bench = typeof TenantResponse.infer;
export type Account = typeof UserProfile.infer;

export class SettingsApiError extends ApiQueryError {
  constructor(message: string, status?: number, path?: string) {
    super(message, status, path);
    this.name = "SettingsApiError";
  }
}

function request<T>(
  path: string,
  schema: Validator<T>,
  verb: string,
  init?: RequestInit,
): Promise<T> {
  return apiRequest(path, schema, verb, SettingsApiError, init, fetch, {
    throwUnauthenticatedOn401: true,
  });
}

export function getAccount(): Promise<Account> {
  return request("/api/me", UserProfile, "loading your account");
}

export function renameBench(tenantId: string, name: string): Promise<Bench> {
  return request(`/api/tenants/${tenantId}`, TenantResponse, "renaming this bench", {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}
