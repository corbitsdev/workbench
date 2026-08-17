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

export function listPendingInvites(
  tenantId: string,
): Promise<readonly PendingInvite[]> {
  return request(
    `/api/tenants/${tenantId}/access-policy/pending-invites`,
    PendingInvitesPage,
    "loading pending invites",
  ).then((page) => page.data);
}

export function createPendingInvite(
  tenantId: string,
  input: {
    readonly matchType: "email" | "domain";
    readonly value: string;
    readonly roleId?: string;
  },
): Promise<PendingInvite> {
  return request(
    `/api/tenants/${tenantId}/access-policy/pending-invites`,
    PendingInvite,
    "adding that invite",
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
    "removing that invite",
    { method: "DELETE" },
  );
}
