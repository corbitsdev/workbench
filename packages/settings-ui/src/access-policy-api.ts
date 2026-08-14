// The People section's seam to `@workbench/access-policy`'s tenant-scoped
// routes (see that package's `src/routes.ts`, mounted at
// `/api/tenants/:tenantId/access-policy`). Every response is parsed with an
// arktype schema at the boundary, the same convention `./tenancy-api.ts`
// already holds for the native routes.

import { type } from "arktype";
import type { ArkErrors } from "arktype";

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

const PendingInvite = type({
  id: "string",
  tenantId: "string",
  matchType: "'email' | 'domain'",
  value: "string",
  "roleId?": "string",
  "invitedBy?": "string",
  createdAt: "string",
  "consumedAt?": "string",
});
export type PendingInvite = typeof PendingInvite.infer;

const PendingInvitesPage = type({ data: PendingInvite.array() });

export class AccessPolicyApiError extends Error {
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
    throw new AccessPolicyApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new AccessPolicyApiError(`Not signed in for ${path}.`, 401);
  }
  if (response.status === 403) {
    throw new AccessPolicyApiError(`Not permitted to view ${path}.`, 403);
  }
  if (!response.ok) {
    throw new AccessPolicyApiError(
      `The hub answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new AccessPolicyApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function getAccessPolicy(tenantId: string): Promise<AccessPolicy> {
  return request(`/api/tenants/${tenantId}/access-policy`, AccessPolicy);
}

export function updateAccessPolicy(
  tenantId: string,
  patch: UpdateAccessPolicy,
): Promise<AccessPolicy> {
  return request(`/api/tenants/${tenantId}/access-policy`, AccessPolicy, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function listPendingInvites(
  tenantId: string,
): Promise<readonly PendingInvite[]> {
  return request(
    `/api/tenants/${tenantId}/access-policy/pending-invites`,
    PendingInvitesPage,
  ).then((page) => page.data);
}

export function createPendingInvite(
  tenantId: string,
  input: { readonly matchType: "email" | "domain"; readonly value: string },
): Promise<PendingInvite> {
  return request(
    `/api/tenants/${tenantId}/access-policy/pending-invites`,
    PendingInvite,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function deletePendingInvite(
  tenantId: string,
  id: string,
): Promise<void> {
  return request<void>(
    `/api/tenants/${tenantId}/access-policy/pending-invites/${id}`,
    (data) => data as void,
    { method: "DELETE" },
  );
}
