// The settings surface's one seam of its own to Interchange's native hub
// routes: renaming a bench (`PATCH /api/tenants/:tenantId`, see
// `vendor/intx/hub-api/src/routes/tenants.ts`) and reading the signed-in
// account's profile (`GET /api/me`). Channel settings and bench membership
// listings are not reimplemented here — they come straight from
// `@corbits/chat-ui` and `@corbits/bench-ui`, the packages that already own
// those seams. Signup policy is operator env exposed at `GET /api/auth-config`.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { TenantResponse, UserProfile } from "@intx/types";

export type Bench = typeof TenantResponse.infer;
export type Account = typeof UserProfile.infer;

export const AuthConfig = type({
  socialProviders: "string[]",
  signupMode: "'open' | 'closed'",
  allowedEmailDomains: "string[]",
});
export type AuthConfig = typeof AuthConfig.infer;

export class SettingsApiError extends Error {
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
    throw new SettingsApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new SettingsApiError(`Not signed in for ${path}.`, 401);
  }
  if (!response.ok) {
    throw new SettingsApiError(
      `The hub answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new SettingsApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function getAccount(): Promise<Account> {
  return request("/api/me", UserProfile);
}

export function getAuthConfig(): Promise<AuthConfig> {
  return request("/api/auth-config", AuthConfig);
}

export function renameBench(tenantId: string, name: string): Promise<Bench> {
  return request(`/api/tenants/${tenantId}`, TenantResponse, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}
