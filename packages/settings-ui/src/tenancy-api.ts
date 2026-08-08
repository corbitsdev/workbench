// The People/Roles/Grants sections' one seam to Interchange's native
// tenancy routes (see vendor/intx/hub-api/src/routes/{principals,roles,
// grants}.ts). Every fetch goes through a function here, and every response
// is parsed with an arktype schema from `@intx/types` at the boundary — the
// same convention `@corbits/bench-ui`'s api.ts already holds.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import {
  EvaluateResult,
  GrantResponse,
  PrincipalResponse,
  RoleResponse,
  paginatedSchema,
  type GrantEffect,
  type GrantOrigin,
  type UpdatablePrincipalStatus,
} from "@intx/types";

export type Principal = typeof PrincipalResponse.infer;
export type Role = typeof RoleResponse.infer;
export type Grant = typeof GrantResponse.infer;

const PrincipalsPage = paginatedSchema(PrincipalResponse);
const RolesPage = paginatedSchema(RoleResponse);
const GrantsPage = paginatedSchema(GrantResponse);

export class TenancyApiError extends Error {
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
    throw new TenancyApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new TenancyApiError(`Not signed in for ${path}.`, 401);
  }
  if (response.status === 403) {
    throw new TenancyApiError(`Not permitted to view ${path}.`, 403);
  }
  if (!response.ok) {
    throw new TenancyApiError(
      `The hub answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new TenancyApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

// -- Principals --------------------------------------------------------

export function listPrincipals(
  tenantId: string,
): Promise<readonly Principal[]> {
  return request(`/api/tenants/${tenantId}/principals`, PrincipalsPage).then(
    (page) => page.data,
  );
}

export function invitePrincipal(
  tenantId: string,
  email: string,
  roleId?: string,
): Promise<Principal> {
  return request(`/api/tenants/${tenantId}/members/invite`, PrincipalResponse, {
    method: "POST",
    body: JSON.stringify(roleId === undefined ? { email } : { email, roleId }),
  });
}

export function updatePrincipalStatus(
  tenantId: string,
  principalId: string,
  status: UpdatablePrincipalStatus,
): Promise<Principal> {
  return request(
    `/api/tenants/${tenantId}/principals/${principalId}`,
    PrincipalResponse,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
}

export function removePrincipal(
  tenantId: string,
  principalId: string,
): Promise<void> {
  return request<void>(
    `/api/tenants/${tenantId}/principals/${principalId}`,
    (data) => data as void,
    { method: "DELETE" },
  );
}

// -- Roles ---------------------------------------------------------------

export function listRoles(tenantId: string): Promise<readonly Role[]> {
  return request(`/api/tenants/${tenantId}/roles`, RolesPage).then(
    (page) => page.data,
  );
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
  return request<void>(
    `/api/tenants/${tenantId}/roles/${roleId}`,
    (data) => data as void,
    { method: "DELETE" },
  );
}

export function assignRole(
  tenantId: string,
  principalId: string,
  roleId: string,
): Promise<void> {
  return request<void>(
    `/api/tenants/${tenantId}/principals/${principalId}/roles/${roleId}`,
    (data) => data as void,
    { method: "POST" },
  );
}

export function unassignRole(
  tenantId: string,
  principalId: string,
  roleId: string,
): Promise<void> {
  return request<void>(
    `/api/tenants/${tenantId}/principals/${principalId}/roles/${roleId}`,
    (data) => data as void,
    { method: "DELETE" },
  );
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
  if (filters.principalId !== undefined)
    params.set("principalId", filters.principalId);
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
  return request(
    `/api/tenants/${tenantId}/grants${grantQuery(filters)}`,
    GrantsPage,
  ).then((page) => page.data);
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

export function createGrant(
  tenantId: string,
  input: CreateGrantInput,
): Promise<Grant> {
  return request(`/api/tenants/${tenantId}/grants`, GrantResponse, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeGrant(tenantId: string, grantId: string): Promise<void> {
  return request<void>(
    `/api/tenants/${tenantId}/grants/${grantId}`,
    (data) => data as void,
    { method: "DELETE" },
  );
}

/**
 * Probes whether the signed-in principal can act on a resource — the one
 * grant-checked route that itself requires no grant (see the tenancy
 * inventory), so it doubles as the permission check that decides whether
 * People/Roles/Grants show up in the settings nav at all.
 */
export function evaluate(
  tenantId: string,
  principalId: string,
  resource: string,
  action: string,
): Promise<typeof EvaluateResult.infer> {
  return request(
    `/api/tenants/${tenantId}/principals/${principalId}/evaluate`,
    EvaluateResult,
    { method: "POST", body: JSON.stringify({ resource, action }) },
  );
}
