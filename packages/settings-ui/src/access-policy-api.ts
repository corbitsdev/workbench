// The People section's seam to `@workbench/access-policy`'s tenant-scoped
// routes (see that package's `src/routes.ts`, mounted at
// `/api/tenants/:tenantId/access-policy`). Every response is parsed with an
// arktype schema at the boundary, the same convention `./tenancy-api.ts`
// already holds for the native routes.

import { type } from "arktype";

import { apiRequest, type Validator } from "./api-request";

export const AccessPolicy = type({
  selfSignup: "'off' | 'allowed-domains' | 'open'",
  allowedDomains: "string[]",
  tenancyCreation: "'owners' | 'owners-admins' | 'none'",
});
export type AccessPolicy = typeof AccessPolicy.infer;

export type UpdateAccessPolicy = {
  readonly selfSignup?: AccessPolicy["selfSignup"];
  readonly allowedDomains?: readonly string[];
  readonly tenancyCreation?: AccessPolicy["tenancyCreation"];
};

export class AccessPolicyApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function request<T>(
  path: string,
  schema: Validator<T>,
  verb: string,
  init?: RequestInit,
): Promise<T> {
  return apiRequest(path, schema, verb, AccessPolicyApiError, init);
}

export function getAccessPolicy(tenantId: string): Promise<AccessPolicy> {
  return request(
    `/api/tenants/${tenantId}/access-policy`,
    AccessPolicy,
    "loading who can join",
  );
}

export function updateAccessPolicy(
  tenantId: string,
  patch: UpdateAccessPolicy,
): Promise<AccessPolicy> {
  return request(
    `/api/tenants/${tenantId}/access-policy`,
    AccessPolicy,
    "saving who can join",
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}
