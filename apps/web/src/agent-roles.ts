// Roles a created agent carries: the form lists the tenant's platform
// roles, the person checks the ones the agent should hold, and the deploy
// assigns them to the agent's workflow principal. Reads resolve against live
// platform roles (never hardcoded ids); tenant bootstrap seeds the system
// roles, so this module creates none. Every step fails closed: an unknown
// name, a principal that does not exist yet, or a refused write aborts the
// operation instead of leaving a half-roled agent behind.
import { paginatedSchema, RoleResponse } from "@intx/types";
import { type } from "arktype";
import type { ArkErrors } from "arktype";

import { UnauthenticatedError } from "@/lib/api-query";

export class AgentRolesError extends Error {}

export type RoleOption = {
  readonly id: string;
  readonly name: string;
  readonly isSystem: boolean;
};

const RolesPage = paginatedSchema(RoleResponse);
// The principal list's own loose shape, the same as threads-api's: a
// removed principal still lists (so it is filtered, not validated away),
// which the shared PrincipalResponse status enum would reject outright.
const PrincipalsPage = type({
  data: type({
    id: "string",
    kind: "string",
    refId: "string",
    displayName: "string",
    status: "string",
  }).array(),
  nextCursor: "string | null",
});

type Validator<T> = (data: unknown) => T | ArkErrors;

function tenantPath(tenantId: string, suffix: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}${suffix}`;
}

async function readPage<T>(response: Response, schema: Validator<T>, what: string): Promise<T> {
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    throw new AgentRolesError(`${what} failed.`);
  }
  const parsed = schema(await response.json().catch(() => undefined));
  if (parsed instanceof type.errors) {
    throw new AgentRolesError(`${what} came back an unexpected shape.`);
  }
  return parsed;
}

async function fetchPage<T>(
  fetchImpl: typeof fetch,
  path: string,
  schema: Validator<T>,
  what: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new AgentRolesError(cause instanceof Error ? cause.message : `${what} failed.`);
  }
  return readPage(response, schema, what);
}

/** Lists the tenant's platform roles (system and custom), oldest first —
 * tenant bootstrap seeds the system roles, so a fresh tenant lists
 * owner/admin/member with nothing to create. */
export async function listTenantRoles(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly RoleOption[]> {
  const roles: RoleOption[] = [];
  let cursor: string | null = null;
  for (;;) {
    const path: string =
      cursor === null
        ? `${tenantPath(tenantId, "/roles")}?limit=100`
        : `${tenantPath(tenantId, "/roles")}?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const page = await fetchPage(fetchImpl, path, RolesPage, "Listing this workbench's roles");
    for (const role of page.data) {
      roles.push({ id: role.id, name: role.name, isSystem: role.isSystem });
    }
    if (page.nextCursor === null) return roles;
    cursor = page.nextCursor;
  }
}

/** Resolves selected role names to the target tenant's role ids. Role ids
 * are per-tenant, so callers pass names and resolve in the tenant the
 * assignment lands in. Fails closed on the first unknown name, before any
 * write, so a typo never half-applies a selection. */
export async function resolveAgentRoleIds(
  tenantId: string,
  names: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<readonly string[]> {
  const wanted = [...new Set(names)];
  if (wanted.length === 0) return [];
  const roles = await listTenantRoles(tenantId, fetchImpl);
  return wanted.map((name) => {
    const found = roles.find((role) => role.name === name);
    if (found === undefined) {
      throw new AgentRolesError(`This workbench has no role named "${name}".`);
    }
    return found.id;
  });
}

export type AgentPrincipalRef = {
  /** The install's deployment id: a deployment's anchor run carries this id,
   * so the run principal minted at first delivery matches it. */
  readonly deploymentId: string;
  /** The agent's run address (`slug@domain`), minted at deploy time: a
   * workflow principal's display name renders as `Workflow (<address>)`. */
  readonly address?: string;
};

/** Finds the agent's workflow principal in the tenant: the anchor run
 * principal by deployment id, else any live run principal under the agent's
 * address. Returns null when the agent has never run — a deployment's
 * workflow principal only appears after its first run, so a fresh agent has
 * nothing to assign to yet. Removed principals never match. */
export async function resolveAgentPrincipalId(
  tenantId: string,
  ref: AgentPrincipalRef,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const expectedName = ref.address === undefined ? null : `Workflow (${ref.address})`;
  let cursor: string | null = null;
  for (;;) {
    const base = `${tenantPath(tenantId, "/principals")}?kind=workflow&limit=100`;
    const path: string = cursor === null ? base : `${base}&cursor=${encodeURIComponent(cursor)}`;
    const page = await fetchPage(
      fetchImpl,
      path,
      PrincipalsPage,
      "Listing this workbench's people",
    );
    for (const principal of page.data) {
      if (principal.status === "removed") continue;
      if (principal.refId === ref.deploymentId) return principal.id;
      if (expectedName !== null && principal.displayName === expectedName) return principal.id;
    }
    if (page.nextCursor === null) return null;
    cursor = page.nextCursor;
  }
}

async function readAssignError(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = type({
    error: { code: "string", "message?": "string", "userMessage?": "string" },
  })(body);
  if (envelope instanceof type.errors) return `HTTP ${response.status}`;
  return envelope.error.userMessage ?? envelope.error.message ?? `HTTP ${response.status}`;
}

/** Assigns each role to the principal, in order, stopping at the first
 * refusal. Assignment is idempotent server-side, so retrying a partial
 * apply converges instead of duplicating. */
export async function assignAgentRoles(
  tenantId: string,
  principalId: string,
  roleIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (const roleId of roleIds) {
    let response: Response;
    try {
      response = await fetchImpl(
        `${tenantPath(tenantId, `/principals/${encodeURIComponent(principalId)}/roles/${encodeURIComponent(roleId)}`)}`,
        { method: "POST" },
      );
    } catch (cause) {
      throw new AgentRolesError(
        cause instanceof Error ? cause.message : "Assigning this role failed.",
      );
    }
    if (!response.ok) {
      throw new AgentRolesError(`Assigning this role failed: ${await readAssignError(response)}`);
    }
  }
}

export type AssignRolesToAgentArgs = {
  readonly tenantId: string;
  /** Role ids already resolved against this tenant; empty is a no-op. */
  readonly roleIds: readonly string[];
  readonly principalRef: AgentPrincipalRef;
};

/** Assigns already-resolved role ids to the agent's workflow principal.
 * Callers resolve names to ids first (failing fast on unknown names before
 * anything deploys), so this runs after the install: a missing principal
 * fails with nothing assigned. An empty id list is a no-op. */
export async function assignRolesToAgent(
  args: AssignRolesToAgentArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (args.roleIds.length === 0) return;
  const principalId = await resolveAgentPrincipalId(args.tenantId, args.principalRef, fetchImpl);
  if (principalId === null) {
    throw new AgentRolesError(
      "This agent hasn't run yet, so its roles can't be assigned. Send it a message, then try again and the roles will apply.",
    );
  }
  await assignAgentRoles(args.tenantId, principalId, args.roleIds, fetchImpl);
}
