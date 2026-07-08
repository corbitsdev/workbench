import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";
import { schema as intxSchema } from "@intx/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  MEMBER_ROLE_NAME,
  WORKFLOW_RUN_ACTION,
  workflowRunResource,
} from "@workbench/shared";
import type { HubDb } from "../db";

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
export async function isWorkflowRunDeniedForTenant(
  db: HubDb,
  tenantChain: readonly string[],
  kind: string,
): Promise<boolean> {
  if (tenantChain.length === 0) return false;
  const memberRoles = await db.query.role.findMany({
    where: and(
      inArray(role.tenantId, [...tenantChain]),
      eq(role.name, MEMBER_ROLE_NAME),
      eq(role.isSystem, true),
    ),
    columns: { id: true },
  });
  if (memberRoles.length === 0) return false;
  const rows = await db.query.grant.findMany({
    where: inArray(
      grant.roleId,
      memberRoles.map((r) => r.id),
    ),
  });
  const grants: GrantRule[] = rows.map((g) => ({
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
  return workflowRunDenied(grants, kind);
}
