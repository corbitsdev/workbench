import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/types/authz";
import { schema as intxSchema } from "@intx/db";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type } from "arktype";
import { generateId } from "@intx/hub-common";
import {
  MEMBER_ROLE_NAME,
  type RunnableWorkflowKind,
  WORKFLOW_RUN_ACTION,
  workflowRunResource,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";

const { role, grant } = intxSchema;

// The transaction handle drizzle hands to a `db.transaction` callback. It has
// the same query/select/insert/delete surface as `HubDb` but is not assignable
// to it (no `$client`), so the row-lock helper is typed against this instead.
type HubTx = Parameters<Parameters<HubDb["transaction"]>[0]>[0];

// Serialize every workflow-run grant mutation on a member role by taking a row
// lock on that role for the rest of the transaction. Seed, enable, and disable
// all lock the same role row, so a concurrent first-publish cannot interleave
// its existence check with another's insert (the double-seed race). This is the
// app-layer stand-in for a DB-level unique index on `(role_id, resource,
// action)`: the `grant` table is interchange-owned and workbench migrations do
// not touch it, so the atomicity guarantee lives here instead of in the schema.
async function lockMemberRoleRow(tx: HubTx, roleId: string): Promise<void> {
  await tx
    .select({ id: role.id })
    .from(role)
    .where(eq(role.id, roleId))
    .for("update");
}

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

// Seed a `deny` grant on the tenant's system `member` role for a workflow
// `kind` that has never had a grant row of its own — first-time publish
// (either the authenticated deploy route or the autopublish boot bootstrap)
// otherwise leaves the kind allow-by-default enabled with no owner action
// taken. A redeploy of a kind that already has a grant row is a no-op: the
// existence check is on any effect, so an owner-written `allow` (enabled) or
// `deny` (disabled) is preserved and a redeploy never re-disables what the
// owner enabled. The check-and-insert runs under a member-role row lock so a
// concurrent first-publish cannot seed a duplicate.
export async function seedDenyGrantForNewWorkflowKind(
  db: HubDb,
  tenantId: string,
  kind: string,
): Promise<void> {
  const memberRole = await db.query.role.findFirst({
    where: and(
      eq(role.tenantId, tenantId),
      eq(role.name, MEMBER_ROLE_NAME),
      eq(role.isSystem, true),
    ),
    columns: { id: true },
  });
  if (!memberRole) return;

  const resource = workflowRunResource(kind);
  await db.transaction(async (tx) => {
    await lockMemberRoleRow(tx, memberRole.id);
    const existing = await tx.query.grant.findFirst({
      where: and(
        eq(grant.roleId, memberRole.id),
        eq(grant.resource, resource),
        eq(grant.action, WORKFLOW_RUN_ACTION),
      ),
      columns: { id: true },
    });
    if (existing) return;

    const now = new Date();
    await tx.insert(grant).values({
      id: generateId("grant"),
      tenantId,
      roleId: memberRole.id,
      resource,
      action: WORKFLOW_RUN_ACTION,
      effect: "deny",
      origin: "system",
      createdAt: now,
      updatedAt: now,
    });
  });
}

// Deny-by-default the ENTIRE existing workflow catalog at rollout: for every
// tenant that has a system `member` role, seed a `deny` on every workflow kind
// that tenant currently has an active (non-deleted) deployment of but no
// workflow-run grant row for. The lazy per-publish seed only covers kinds that
// are (re)published after the gate ships; a kind already deployed and never
// republished would otherwise stay at zero rows — allow-by-default enabled —
// indefinitely. This reconcile makes that catalog explicitly disabled so an
// owner opts back in per kind. Idempotent and non-destructive: it reuses
// `seedDenyGrantForNewWorkflowKind`, which only fills a zero-row kind under the
// member-role lock, so re-running seeds nothing new and an owner-written `allow`
// (enabled) or `deny` (disabled) is never overwritten. Safe to run on every
// boot for exactly that reason.
export async function backfillDenyForExistingWorkflowKinds(
  db: HubDb,
): Promise<void> {
  const memberRoles = await db.query.role.findMany({
    where: and(eq(role.name, MEMBER_ROLE_NAME), eq(role.isSystem, true)),
    columns: { tenantId: true },
  });
  for (const memberRole of memberRoles) {
    const deployed = await db
      .selectDistinct({ kind: workflowRun.kind })
      .from(workflowRun)
      .where(
        and(
          eq(workflowRun.tenantId, memberRole.tenantId),
          isNotNull(workflowRun.deploymentId),
          isNull(workflowRun.deletedAt),
        ),
      );
    for (const { kind } of deployed) {
      await seedDenyGrantForNewWorkflowKind(db, memberRole.tenantId, kind);
    }
  }
}

// Set a workflow `kind`'s run-enablement for a tenant as a durable grant on its
// system `member` role: `enabled` writes an `allow`, `disabled` writes a `deny`.
// Enabled is a persisted `allow` row (not the absence of a deny) so the three
// states stay distinct — `deny` = owner-disabled, `allow` = owner-enabled,
// no row = never decided — and a redeploy's seed leaves an enabled kind alone.
// Runtime semantics are unchanged (the gate is deny-beats-allow and a lone
// allow reads as not-denied); the allow row is the durable record of owner
// intent. Runs under a member-role row lock, replacing any prior workflow-run
// grant for the kind with exactly one row, so it is atomic against a concurrent
// seed or toggle.
export async function setWorkflowRunGrant(
  db: HubDb,
  args: { tenantId: string; roleId: string; kind: string; enabled: boolean },
): Promise<void> {
  const resource = workflowRunResource(args.kind);
  const effect = args.enabled ? "allow" : "deny";
  await db.transaction(async (tx) => {
    await lockMemberRoleRow(tx, args.roleId);
    await tx
      .delete(grant)
      .where(
        and(
          eq(grant.roleId, args.roleId),
          eq(grant.resource, resource),
          eq(grant.action, WORKFLOW_RUN_ACTION),
        ),
      );
    const now = new Date();
    await tx.insert(grant).values({
      id: generateId("grant"),
      tenantId: args.tenantId,
      roleId: args.roleId,
      resource,
      action: WORKFLOW_RUN_ACTION,
      effect,
      origin: "system",
      createdAt: now,
      updatedAt: now,
    });
  });
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
