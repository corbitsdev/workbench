import { and, desc, eq, inArray } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { type GrantStore } from "@intx/authz";
import {
  ADMIN_ROLE_NAME,
  type DefinitionSummary,
  type PrincipalGrantsResponse,
  type PrincipalSummary,
  type ResolvedGrant,
  type RoleSummary,
  type WorkflowDeploymentHistoryEntry,
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

export interface PrincipalListFilter {
  /** Narrow to human members (`user`) or agent-instance synthetics (`agent`). */
  type?: "user" | "agent" | undefined;
  /** Case-insensitive substring match on display name or principal id. */
  search?: string | undefined;
  page: number;
  limit: number;
}

export interface PrincipalListPage {
  principals: PrincipalSummary[];
  total: number;
}

/**
 * A tenant's principals — human members plus agent-instance synthetic
 * principals — with each one's role assignments, filtered (type + search) and
 * paginated (CL-2807). Mirrors actor-search's two tenant-scoped joins. The full
 * roster is gathered once, then filtered/sliced in memory: a tenant's principal
 * count is bounded (members + agent instances), so a page query is cheap and
 * the type/name filter reads identically across both principal kinds without a
 * per-kind SQL branch.
 */
export async function listTenantPrincipals(
  db: HubDb,
  tenantId: string,
  filter: PrincipalListFilter,
): Promise<PrincipalListPage> {
  const all = await gatherTenantPrincipals(db, tenantId);

  const search = filter.search?.trim().toLowerCase();
  const filtered = all.filter((p) => {
    if (filter.type && p.kind !== filter.type) return false;
    if (search) {
      const hay = `${p.displayName} ${p.id} ${p.refId}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const start = (filter.page - 1) * filter.limit;
  const principals = filtered.slice(start, start + filter.limit);
  return { principals, total };
}

/** One principal (human or agent) in a tenant, or null if absent. Backs the
 * principal detail page (CL-2807). */
export async function getTenantPrincipal(
  db: HubDb,
  tenantId: string,
  principalId: string,
): Promise<PrincipalSummary | null> {
  const all = await gatherTenantPrincipals(db, tenantId);
  return all.find((p) => p.id === principalId) ?? null;
}

/** Every principal in a tenant with its roles, unfiltered and unpaginated. */
async function gatherTenantPrincipals(
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

/** The tenant's agent definitions as normalized definition summaries. */
export async function listAgentDefinitionSummaries(
  db: HubDb,
  tenantId: string,
): Promise<DefinitionSummary[]> {
  const rows = await db
    .select({
      id: agent.id,
      name: agent.name,
      version: agent.currentVersion,
      status: agent.status,
      description: agent.description,
      createdAt: agent.createdAt,
    })
    .from(agent)
    .where(eq(agent.tenantId, tenantId))
    .orderBy(agent.name);
  return rows.map((r) => ({
    kind: "agent" as const,
    key: r.id,
    name: r.name,
    version: r.version,
    status: r.status,
    description: r.description ?? null,
    deploymentCount: 1,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * The tenant's REAL workflow definitions (CL-2807), read from the hub-local
 * deployment index (`workflow_run`) but reduced to genuine definitions:
 *
 *  - Only rows whose `kind` is in the build-time embedded catalog allowlist
 *    (`allowedKinds`) survive. This excludes the junk the previous browser
 *    dumped — a bare workflow STEP (`skipWriteBack`, `source`), a per-run
 *    supervisor (`supervisor-ses_…`) — that unvalidated direct deploys wrote
 *    into the index as if each were its own workflow.
 *  - Rows are grouped by `kind` into one summary per definition. Every
 *    deployment of that kind (including superseded/deleted redeploys) counts
 *    toward `deploymentCount`; the newest live-or-latest row supplies the
 *    representative status/version/label.
 */
export async function listWorkflowDefinitionSummaries(
  db: HubDb,
  tenantId: string,
  allowedKinds: Set<string>,
): Promise<DefinitionSummary[]> {
  const rows = await db
    .select({
      kind: workflowRun.kind,
      status: workflowRun.status,
      meta: workflowRun.meta,
      deletedAt: workflowRun.deletedAt,
      createdAt: workflowRun.createdAt,
    })
    .from(workflowRun)
    .where(eq(workflowRun.tenantId, tenantId))
    .orderBy(desc(workflowRun.createdAt));

  const byKind = new Map<string, DefinitionSummary>();
  for (const r of rows) {
    if (!allowedKinds.has(r.kind)) continue;
    const existing = byKind.get(r.kind);
    if (existing) {
      existing.deploymentCount += 1;
      continue;
    }
    // Rows are newest-first, so the first row seen for a kind is its
    // representative (latest) deployment.
    byKind.set(r.kind, {
      kind: "workflow",
      key: r.kind,
      name: r.meta?.label ?? r.kind,
      version: r.meta?.version ?? null,
      status: r.status,
      description: r.meta?.description ?? null,
      deploymentCount: 1,
      createdAt: r.createdAt.toISOString(),
    });
  }
  return [...byKind.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The deployment history for one workflow kind: every `workflow_run` row for
 * that (kind, tenant), newest first, with its deploy-time provenance. Backs the
 * workflow definition detail page — the per-run/redeploy rows grouped under the
 * definition, which the list view only counts.
 */
export async function getWorkflowDeploymentHistory(
  db: HubDb,
  tenantId: string,
  kind: string,
): Promise<WorkflowDeploymentHistoryEntry[]> {
  const rows = await db
    .select({
      deploymentId: workflowRun.deploymentId,
      status: workflowRun.status,
      meta: workflowRun.meta,
      createdAt: workflowRun.createdAt,
    })
    .from(workflowRun)
    .where(and(eq(workflowRun.tenantId, tenantId), eq(workflowRun.kind, kind)))
    .orderBy(desc(workflowRun.createdAt));
  return rows.map((r) => ({
    deploymentId: r.deploymentId ?? null,
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
