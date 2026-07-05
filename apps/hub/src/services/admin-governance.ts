import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { type GrantStore } from "@intx/authz";
import {
  ADMIN_ROLE_NAME,
  type AgentDefinitionSummary,
  type PrincipalGrantsResponse,
  type PrincipalSummary,
  type ResolvedGrant,
  type RoleSummary,
  type WorkflowDefinitionSummary,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";

const { principal, user, agent, agentInstance, role, principalRole } =
  intxSchema;

// A principal is an admin when it holds the `owner` or `admin` system role —
// those are the roles whose wildcard grants satisfy the admin gate. Deriving it
// from role membership (rather than an authorize per principal) keeps the
// roster query cheap while staying faithful to the native model.
const ADMIN_ROLE_NAMES = new Set<string>(["owner", ADMIN_ROLE_NAME]);

async function rolesByPrincipal(
  db: HubDb,
  tenantId: string,
): Promise<Map<string, { id: string; name: string }[]>> {
  const rows = await db
    .select({
      principalId: principalRole.principalId,
      roleId: role.id,
      roleName: role.name,
    })
    .from(principalRole)
    .innerJoin(role, eq(role.id, principalRole.roleId))
    .where(eq(role.tenantId, tenantId));
  const map = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) {
    const list = map.get(r.principalId) ?? [];
    list.push({ id: r.roleId, name: r.roleName });
    map.set(r.principalId, list);
  }
  return map;
}

/**
 * Every principal in a tenant — human members plus agent-instance synthetic
 * principals — with each one's role assignments. Mirrors actor-search's two
 * tenant-scoped joins but without the name filter (list, not search).
 */
export async function listTenantPrincipals(
  db: HubDb,
  tenantId: string,
): Promise<PrincipalSummary[]> {
  const roleMap = await rolesByPrincipal(db, tenantId);

  const userRows = await db
    .select({
      id: principal.id,
      refId: principal.refId,
      status: principal.status,
      name: user.name,
      email: user.email,
    })
    .from(principal)
    .innerJoin(user, eq(principal.refId, user.id))
    .where(and(eq(principal.tenantId, tenantId), eq(principal.kind, "user")));

  const agentRows = await db
    .select({
      id: principal.id,
      refId: principal.refId,
      status: principal.status,
      name: agent.name,
    })
    .from(principal)
    .innerJoin(agentInstance, eq(principal.refId, agentInstance.id))
    .innerJoin(agent, eq(agentInstance.agentId, agent.id))
    .where(and(eq(principal.tenantId, tenantId), eq(principal.kind, "agent")));

  const toSummary = (
    id: string,
    kind: "user" | "agent",
    refId: string,
    status: string,
    displayName: string,
  ): PrincipalSummary => {
    const roles = roleMap.get(id) ?? [];
    return {
      id,
      kind,
      refId,
      status,
      displayName,
      roles,
      isAdmin: roles.some((r) => ADMIN_ROLE_NAMES.has(r.name)),
    };
  };

  const principals: PrincipalSummary[] = [
    ...userRows.map((r) =>
      toSummary(r.id, "user", r.refId, r.status, r.name || r.email),
    ),
    ...agentRows.map((r) =>
      toSummary(r.id, "agent", r.refId, r.status, r.name),
    ),
  ];
  principals.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return principals;
}

/** Batched principal-id → display-name resolver (users and agent instances). */
export async function resolvePrincipalNames(
  db: HubDb,
  tenantId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  const names = new Map<string, string>();
  if (unique.length === 0) return names;

  const userRows = await db
    .select({ id: principal.id, name: user.name, email: user.email })
    .from(principal)
    .innerJoin(user, eq(principal.refId, user.id))
    .where(
      and(eq(principal.tenantId, tenantId), inArray(principal.id, unique)),
    );
  for (const r of userRows) names.set(r.id, r.name || r.email);

  const agentRows = await db
    .select({ id: principal.id, name: agent.name })
    .from(principal)
    .innerJoin(agentInstance, eq(principal.refId, agentInstance.id))
    .innerJoin(agent, eq(agentInstance.agentId, agent.id))
    .where(
      and(eq(principal.tenantId, tenantId), inArray(principal.id, unique)),
    );
  for (const r of agentRows) names.set(r.id, r.name);

  return names;
}

export async function listTenantRoles(
  db: HubDb,
  tenantId: string,
): Promise<RoleSummary[]> {
  const rows = await db
    .select({
      id: role.id,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
    })
    .from(role)
    .where(eq(role.tenantId, tenantId))
    .orderBy(role.name);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    isSystem: r.isSystem,
  }));
}

/**
 * A principal's resolved grants (direct + role-expanded via `collectGrants`)
 * plus its role assignments. `collectGrants` returns role ids but not names, so
 * role names are joined in from the tenant roles.
 */
export async function getPrincipalGrants(
  db: HubDb,
  grantStore: GrantStore,
  tenantId: string,
  principalId: string,
): Promise<PrincipalGrantsResponse> {
  const [roleMap, allRoles, rules] = await Promise.all([
    rolesByPrincipal(db, tenantId),
    listTenantRoles(db, tenantId),
    grantStore.collectGrants(principalId, tenantId),
  ]);
  const roleNameById = new Map(allRoles.map((r) => [r.id, r.name]));
  const assignedRoles = roleMap.get(principalId) ?? [];

  const grants: ResolvedGrant[] = rules.map((rule) => ({
    id: rule.id,
    resource: rule.resource,
    action: rule.action,
    effect: rule.effect,
    origin: rule.origin,
    roleId: rule.roleId ?? null,
    roleName: rule.roleId ? (roleNameById.get(rule.roleId) ?? null) : null,
    principalId: rule.principalId ?? null,
    expiresAt: rule.expiresAt ? rule.expiresAt.toISOString() : null,
  }));

  const roles: RoleSummary[] = assignedRoles.map((r) => {
    const full = allRoles.find((ar) => ar.id === r.id);
    return {
      id: r.id,
      name: r.name,
      description: full?.description ?? null,
      isSystem: full?.isSystem ?? false,
    };
  });

  return {
    principalId,
    isAdmin: assignedRoles.some((r) => ADMIN_ROLE_NAMES.has(r.name)),
    roles,
    grants,
  };
}

export async function listAgentDefinitions(
  db: HubDb,
  tenantId: string,
): Promise<AgentDefinitionSummary[]> {
  const rows = await db
    .select({
      id: agent.id,
      name: agent.name,
      tenantId: agent.tenantId,
      version: agent.currentVersion,
      status: agent.status,
      description: agent.description,
      createdAt: agent.createdAt,
    })
    .from(agent)
    .where(eq(agent.tenantId, tenantId))
    .orderBy(agent.name);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tenantId: r.tenantId,
    version: r.version,
    status: r.status,
    description: r.description ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Active workflow deployments in a tenant, read from the hub-local deployment
 * index (`workflow_run`). One row per live deployment (deletedAt IS NULL) with
 * the deploy-time provenance (`meta`) surfaced for the browser.
 */
export async function listWorkflowDefinitions(
  db: HubDb,
  tenantId: string,
): Promise<WorkflowDefinitionSummary[]> {
  const rows = await db
    .select({
      deploymentId: workflowRun.deploymentId,
      kind: workflowRun.kind,
      tenantId: workflowRun.tenantId,
      status: workflowRun.status,
      meta: workflowRun.meta,
      createdAt: workflowRun.createdAt,
    })
    .from(workflowRun)
    .where(
      and(eq(workflowRun.tenantId, tenantId), isNull(workflowRun.deletedAt)),
    )
    .orderBy(desc(workflowRun.createdAt));
  return rows.map((r) => ({
    deploymentId: r.deploymentId ?? null,
    kind: r.kind,
    tenantId: r.tenantId,
    status: r.status,
    version: r.meta?.version ?? null,
    sha: r.meta?.sha ?? null,
    label: r.meta?.label ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ─── Mutations (native role storage) ───────────────────────────────
//
// These write directly to Interchange's own `principal_role` table — the same
// rows the native role-assign HTTP routes create — using Interchange's schema.
// They are NOT a parallel permission model: the evaluation engine
// (authorize/collectGrants), schema, and semantics stay native. The
// workbench-owned wrapper exists so every mutation is admin-gated, validates
// the target principal, and is audit-logged (CL-2735/CL-2736). The only
// enforced management operation today is admin role assignment (elevate/demote)
// — per-capability grant sharing is deferred to CL-2799.

/** Whether a principal id exists within the tenant. Guards role writes against
 * unknown/foreign ids (parity with the native hub-api routes). */
export async function principalExistsInTenant(
  db: HubDb,
  tenantId: string,
  principalId: string,
): Promise<boolean> {
  const row = await db.query.principal.findFirst({
    where: and(eq(principal.id, principalId), eq(principal.tenantId, tenantId)),
    columns: { id: true },
  });
  return row !== undefined;
}

export async function assignRole(
  db: HubDb,
  tenantId: string,
  principalId: string,
  roleId: string,
): Promise<void> {
  const roleRow = await db.query.role.findFirst({
    where: and(eq(role.id, roleId), eq(role.tenantId, tenantId)),
  });
  if (!roleRow) throw new RoleNotFoundError(roleId);
  await db
    .insert(principalRole)
    .values({ principalId, roleId })
    .onConflictDoNothing();
}

export async function removeRole(
  db: HubDb,
  principalId: string,
  roleId: string,
): Promise<void> {
  await db
    .delete(principalRole)
    .where(
      and(
        eq(principalRole.principalId, principalId),
        eq(principalRole.roleId, roleId),
      ),
    );
}

/** The tenant's `admin` system role id, for the "elevate to admin" action. */
export async function findAdminRoleId(
  db: HubDb,
  tenantId: string,
): Promise<string | null> {
  const row = await db.query.role.findFirst({
    where: and(eq(role.tenantId, tenantId), eq(role.name, ADMIN_ROLE_NAME)),
  });
  return row?.id ?? null;
}

export class RoleNotFoundError extends Error {
  constructor(roleId: string) {
    super(`Role ${roleId} not found in tenant`);
    this.name = "RoleNotFoundError";
  }
}
