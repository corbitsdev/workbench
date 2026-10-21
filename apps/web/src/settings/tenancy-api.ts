import {
  EvaluateResult,
  GrantResponse,
  InviteMember,
  PrincipalResponse,
  RoleResponse,
  paginatedSchema,
  type GrantEffect,
  type GrantOrigin,
  type UpdatablePrincipalStatus,
} from "@intx/types";
import { ApiQueryError } from "@/lib/api-query";
import { apiRequest, requestVoid as sharedRequestVoid, type Validator } from "../api";

export type Principal = typeof PrincipalResponse.infer;
export type Role = typeof RoleResponse.infer;
export type Grant = typeof GrantResponse.infer;

const PrincipalsPage = paginatedSchema(PrincipalResponse);
const RolesPage = paginatedSchema(RoleResponse);
const GrantsPage = paginatedSchema(GrantResponse);

export class TenancyApiError extends ApiQueryError {
  constructor(message: string, status?: number, path?: string) {
    super(message, status, path);
    this.name = "TenancyApiError";
  }
}

/**
 * The hub answers 404 when the principal or role on an assignment path does
 * not exist in the tenant -- most often a machine principal the picker listed
 * from a stale snapshot, or one never minted because its first run has not
 * happened yet. Callers use this to explain that case instead of reporting a
 * generic transient failure.
 */
export function isNotFoundError(cause: unknown): boolean {
  return cause instanceof TenancyApiError && cause.status === 404;
}

function request<T>(path: string, schema: Validator<T>, init?: RequestInit): Promise<T> {
  return apiRequest(path, schema, undefined, TenancyApiError, init, fetch, {
    throwUnauthenticatedOn401: true,
  });
}

function requestVoid(path: string, init?: RequestInit): Promise<void> {
  return sharedRequestVoid(path, undefined, TenancyApiError, init, fetch, {
    throwUnauthenticatedOn401: true,
  });
}

// -- Principals --------------------------------------------------------

export function listPrincipals(tenantId: string): Promise<readonly Principal[]> {
  return request(`/api/tenants/${tenantId}/principals`, PrincipalsPage).then((page) => page.data);
}

export function updatePrincipalStatus(
  tenantId: string,
  principalId: string,
  status: UpdatablePrincipalStatus,
): Promise<Principal> {
  return request(`/api/tenants/${tenantId}/principals/${principalId}`, PrincipalResponse, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function removePrincipal(tenantId: string, principalId: string): Promise<void> {
  return requestVoid(`/api/tenants/${tenantId}/principals/${principalId}`, { method: "DELETE" });
}

export type InviteMemberInput = typeof InviteMember.infer;

// The invited user must already have an account — no invite-by-email-only
// flow exists.
export function inviteMember(tenantId: string, input: InviteMemberInput): Promise<Principal> {
  return request(`/api/tenants/${tenantId}/members/invite`, PrincipalResponse, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// -- Roles ---------------------------------------------------------------

export function listRoles(tenantId: string): Promise<readonly Role[]> {
  return request(`/api/tenants/${tenantId}/roles`, RolesPage).then((page) => page.data);
}

export function createRole(
  tenantId: string,
  input: { readonly name: string; readonly description?: string },
): Promise<Role> {
  return request(`/api/tenants/${tenantId}/roles`, RoleResponse, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function renameRole(
  tenantId: string,
  roleId: string,
  input: { readonly name?: string; readonly description?: string },
): Promise<Role> {
  return request(`/api/tenants/${tenantId}/roles/${roleId}`, RoleResponse, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteRole(tenantId: string, roleId: string): Promise<void> {
  return requestVoid(`/api/tenants/${tenantId}/roles/${roleId}`, { method: "DELETE" });
}

export function assignRole(tenantId: string, principalId: string, roleId: string): Promise<void> {
  return requestVoid(`/api/tenants/${tenantId}/principals/${principalId}/roles/${roleId}`, {
    method: "POST",
  });
}

export function unassignRole(tenantId: string, principalId: string, roleId: string): Promise<void> {
  return requestVoid(`/api/tenants/${tenantId}/principals/${principalId}/roles/${roleId}`, {
    method: "DELETE",
  });
}

// -- Grants ----------------------------------------------------------------

export type GrantFilters = {
  readonly principalId?: string;
  readonly roleId?: string;
  readonly resource?: string;
  readonly effect?: GrantEffect;
};

function grantQuery(filters: GrantFilters): string {
  const params = new URLSearchParams();
  if (filters.principalId !== undefined) params.set("principalId", filters.principalId);
  if (filters.roleId !== undefined) params.set("roleId", filters.roleId);
  if (filters.resource !== undefined) params.set("resource", filters.resource);
  if (filters.effect !== undefined) params.set("effect", filters.effect);
  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
}

export function listGrants(
  tenantId: string,
  filters: GrantFilters = {},
): Promise<readonly Grant[]> {
  return request(`/api/tenants/${tenantId}/grants${grantQuery(filters)}`, GrantsPage).then(
    (page) => page.data,
  );
}

export type CreateGrantInput = {
  readonly roleId?: string;
  readonly principalId?: string;
  readonly resource: string;
  readonly action: string;
  readonly effect: GrantEffect;
  readonly origin: GrantOrigin;
  readonly expiresAt?: string;
};

export function createGrant(tenantId: string, input: CreateGrantInput): Promise<Grant> {
  return request(`/api/tenants/${tenantId}/grants`, GrantResponse, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateGrant(
  tenantId: string,
  grantId: string,
  patch: { readonly effect: GrantEffect },
): Promise<Grant> {
  return request(`/api/tenants/${tenantId}/grants/${grantId}`, GrantResponse, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function revokeGrant(tenantId: string, grantId: string): Promise<void> {
  return requestVoid(`/api/tenants/${tenantId}/grants/${grantId}`, { method: "DELETE" });
}

// The one grant-checked route that itself requires no grant, so it
// doubles as the check deciding whether People/Roles/Grants show up.
export function evaluate(
  tenantId: string,
  principalId: string,
  resource: string,
  action: string,
): Promise<typeof EvaluateResult.infer> {
  return request(`/api/tenants/${tenantId}/principals/${principalId}/evaluate`, EvaluateResult, {
    method: "POST",
    body: JSON.stringify({ resource, action }),
  });
}
