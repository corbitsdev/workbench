import { and, desc, eq } from "drizzle-orm";
import { autoApprovedTool } from "../db/schema";
import type { HubDb } from "../db";

/**
 * A durable auto-approved tool record, shaped for the wire (ISO timestamp).
 */
export type AutoApprovedToolRow = {
  id: string;
  tenantId: string;
  principalId: string;
  toolName: string;
  createdByPrincipalId: string;
  createdAt: string;
};

/** A workbench-local id: `generateId` only accepts interchange's fixed prefix
 * set, so a workbench-owned row mints its own prefixed random id. */
function newAutoApprovedToolId(): string {
  return `aat_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * The LLM-safe tool names an instance principal has durably auto-approved. The
 * grant minting subtracts this from the approval-gated ask set so an
 * auto-approved tool mints `effect: "allow"` and no longer suspends.
 */
export async function resolveAutoApprovedToolNames(
  db: HubDb,
  tenantId: string,
  principalId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ toolName: autoApprovedTool.toolName })
    .from(autoApprovedTool)
    .where(
      and(
        eq(autoApprovedTool.tenantId, tenantId),
        eq(autoApprovedTool.principalId, principalId),
      ),
    );
  return new Set(rows.map((r) => r.toolName));
}

/**
 * Record (idempotently) a member's durable auto-approve decision for one tool on
 * one agent-instance principal. The unique index on
 * `(tenant, principal, tool_name)` makes a repeat click a no-op rather than a
 * duplicate row. Attributed to the member principal who made the decision.
 */
export async function persistAutoApprovedTool(
  db: HubDb,
  args: {
    tenantId: string;
    principalId: string;
    toolName: string;
    createdByPrincipalId: string;
  },
): Promise<void> {
  await db
    .insert(autoApprovedTool)
    .values({
      id: newAutoApprovedToolId(),
      tenantId: args.tenantId,
      principalId: args.principalId,
      toolName: args.toolName,
      createdByPrincipalId: args.createdByPrincipalId,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * List a member's own auto-approve decisions across every instance they own,
 * newest first. Scoped by `created_by_principal_id` so one member never sees
 * another member's trust decisions.
 */
export async function listAutoApprovedToolsForMember(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
): Promise<AutoApprovedToolRow[]> {
  const rows = await db
    .select()
    .from(autoApprovedTool)
    .where(
      and(
        eq(autoApprovedTool.tenantId, tenantId),
        eq(autoApprovedTool.createdByPrincipalId, memberPrincipalId),
      ),
    )
    .orderBy(desc(autoApprovedTool.createdAt));
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    principalId: r.principalId,
    toolName: r.toolName,
    createdByPrincipalId: r.createdByPrincipalId,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Revoke one auto-approve decision the caller made. Scoped to the caller's own
 * records so a member can only undo their own trust; returns the deleted row's
 * `(principalId, toolName)` so the caller can re-mint that instance's grants
 * (reverting the tool to `ask`). Null when nothing matched.
 */
export async function deleteAutoApprovedTool(
  db: HubDb,
  args: { tenantId: string; id: string; memberPrincipalId: string },
): Promise<{ principalId: string; toolName: string } | null> {
  const deleted = await db
    .delete(autoApprovedTool)
    .where(
      and(
        eq(autoApprovedTool.id, args.id),
        eq(autoApprovedTool.tenantId, args.tenantId),
        eq(autoApprovedTool.createdByPrincipalId, args.memberPrincipalId),
      ),
    )
    .returning({
      principalId: autoApprovedTool.principalId,
      toolName: autoApprovedTool.toolName,
    });
  const row = deleted[0];
  return row ? { principalId: row.principalId, toolName: row.toolName } : null;
}
