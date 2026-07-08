import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";
import { schema as intxSchema } from "@intx/db";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type } from "arktype";
import {
  MEMBER_ROLE_NAME,
  type RunnableWorkflowKind,
  WORKFLOW_RUN_ACTION,
  workflowRunResource,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";

const { role, grant } = intxSchema;

// Whether running `kind` is DENIED for a tenant, decided over the tenant's (and
// its ancestors') `member`-role grants through the REAL authz matcher. The gate
// is ALLOW-BY-DEFAULT: workflows ran for everyone before this gate existed, so a
// run is blocked only by an explicit `deny` on `workflow:<kind>`/`run` (or a
// `workflow:*` deny) — which the owner area writes to disable a workflow. Absent
// any grant → no match → not denied → allowed. Pure over the passed grants;
// reuses `evaluateGrants` so deny-beats-allow and glob semantics stay correct.
export async function workflowRunDenied(
  memberRoleGrants: GrantRule[],
  kind: string,
): Promise<boolean> {
  const result = await evaluateGrants(
    memberRoleGrants,
    workflowRunResource(kind),
    WORKFLOW_RUN_ACTION,
  );
  return result.effect === "deny";
}

// Resolves the tenant policy from the DB and applies `workflowRunDenied`. The
// `tenantChain` is the run path's existing ancestor chain (`getAncestorChain`),
// so a deny set on a parent tenant disables the workflow for descendants too.
export async function loadMemberRoleGrantsForTenantChain(
  db: HubDb,
  tenantChain: readonly string[],
): Promise<GrantRule[]> {
  if (tenantChain.length === 0) return [];
  const memberRoles = await db.query.role.findMany({
    where: and(
      inArray(role.tenantId, [...tenantChain]),
      eq(role.name, MEMBER_ROLE_NAME),
      eq(role.isSystem, true),
    ),
    columns: { id: true },
  });
  if (memberRoles.length === 0) return [];
  const rows = await db.query.grant.findMany({
    where: inArray(
      grant.roleId,
      memberRoles.map((r) => r.id),
    ),
  });
  return rows.map((g) => ({
    id: g.id,
    resource: g.resource,
    action: g.action,
    effect: g.effect,
    origin: g.origin,
    conditions: (g.conditions as Record<string, unknown> | null) ?? null,
    expiresAt: g.expiresAt,
    roleId: g.roleId,
    principalId: g.principalId,
  }));
}

export async function isWorkflowRunDeniedForTenant(
  db: HubDb,
  tenantChain: readonly string[],
  kind: string,
): Promise<boolean> {
  const grants = await loadMemberRoleGrantsForTenantChain(db, tenantChain);
  return workflowRunDenied(grants, kind);
}

export type WorkflowDeploymentCatalogRow = {
  deploymentId: string;
  kind: string;
  status: string;
  createdAt: string;
  meta?: unknown;
};

export async function workflowKindRunnableFromGrants(
  memberRoleGrants: GrantRule[],
  kind: string,
): Promise<boolean> {
  return !(await workflowRunDenied(memberRoleGrants, kind));
}

export async function filterDeploymentsToRunnable(
  db: HubDb,
  tenantChain: readonly string[],
  rows: readonly WorkflowDeploymentCatalogRow[],
): Promise<WorkflowDeploymentCatalogRow[]> {
  const grants = await loadMemberRoleGrantsForTenantChain(db, tenantChain);
  const out: WorkflowDeploymentCatalogRow[] = [];
  for (const row of rows) {
    if (await workflowKindRunnableFromGrants(grants, row.kind)) {
      out.push(row);
    }
  }
  return out;
}

const WorkflowDeploymentMetaSchema = type({
  "label?": "string",
  "description?": "string",
  "+": "ignore",
});

export async function listRunnableWorkflowDeployments(
  db: HubDb,
  chain: readonly string[],
): Promise<WorkflowDeploymentCatalogRow[]> {
  const rows = await db
    .select({
      deploymentId: workflowRun.deploymentId,
      kind: workflowRun.kind,
      status: workflowRun.status,
      createdAt: workflowRun.createdAt,
      meta: workflowRun.meta,
    })
    .from(workflowRun)
    .where(
      and(
        inArray(workflowRun.tenantId, chain),
        isNotNull(workflowRun.deploymentId),
        isNull(workflowRun.deletedAt),
      ),
    )
    .orderBy(desc(workflowRun.createdAt));
  const catalogRows: WorkflowDeploymentCatalogRow[] = [];
  for (const row of rows) {
    if (row.deploymentId === null) continue;
    catalogRows.push({
      deploymentId: row.deploymentId,
      kind: row.kind,
      status: row.status,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
      ...(row.meta !== null && row.meta !== undefined
        ? { meta: row.meta }
        : {}),
    });
  }
  return filterDeploymentsToRunnable(db, chain, catalogRows);
}

export async function listRunnableWorkflowKinds(
  db: HubDb,
  chain: readonly string[],
): Promise<RunnableWorkflowKind[]> {
  const runnable = await listRunnableWorkflowDeployments(db, chain);
  return distinctRunnableKindsFromDeployments(runnable);
}

export function distinctRunnableKindsFromDeployments(
  rows: readonly WorkflowDeploymentCatalogRow[],
): RunnableWorkflowKind[] {
  const seen = new Set<string>();
  const entries: RunnableWorkflowKind[] = [];
  for (const row of rows) {
    if (seen.has(row.kind)) continue;
    seen.add(row.kind);
    const parsed = WorkflowDeploymentMetaSchema(row.meta);
    const meta = parsed instanceof type.errors ? {} : parsed;
    const label =
      meta.label !== undefined && meta.label.trim() !== ""
        ? meta.label
        : undefined;
    const description =
      meta.description !== undefined && meta.description.trim() !== ""
        ? meta.description
        : undefined;
    entries.push({
      kind: row.kind,
      ...(label !== undefined ? { label } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  }
  return entries;
}
