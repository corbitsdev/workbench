import { inArray } from "drizzle-orm";
import { type } from "arktype";

import type { DBExecutor } from "@intx/db";
import { schema, parseApprovalRow } from "@intx/db";

type ApprovalRow = ReturnType<typeof parseApprovalRow>;

// The shape a human decides against. Every identifier the underlying
// `approval` row carries (agentAddress, deploymentId, tenantId) is resolved
// here into a name before this type's only two producers -- `hydrateNeedsYou`
// and its tests -- ever construct one, so nothing downstream can render a raw
// id even by accident: there is no field on this type that holds one.
//
// `status` carries the full `approval.status` union (not just `"pending"`):
// the list route (`GET /`) only ever queries pending rows, so its items are
// always `"pending"` in practice, but the single-item detail route
// (`GET /:approvalId`) hydrates a row in any status so a caller that already
// knows the id -- an in-chat approve card re-reading after resolve -- can
// render "approved"/"rejected"/etc. through the same display-safe shape.
export const NeedsYouItem = type({
  id: "string",
  agentName: "string",
  benchName: "string",
  headline: "string",
  arguments: "object",
  status: "'pending' | 'approved' | 'rejected' | 'timeout' | 'expired'",
  createdAt: "string.date.iso",
});
export type NeedsYouItem = typeof NeedsYouItem.infer;

function stringField(source: object, field: string): string | undefined {
  if (!(field in source)) return undefined;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Builds the inbox headline for a pending approval. Prefers the tool's
 * own `description` — written by the tool's author to be human-readable
 * — over its bare `name`, which is a machine identifier. When the live
 * call's arguments carry a `title` (a tool author's own convention for
 * per-invocation context, e.g. "finalize this piece of collateral
 * titled X"), it is appended so the headline reflects what THIS
 * approval is actually about, not just which tool is asking.
 */
export function headlineFor(
  toolDefinition: unknown,
  toolArguments: unknown,
): string {
  const base =
    typeof toolDefinition === "object" && toolDefinition !== null
      ? (stringField(toolDefinition, "description") ??
        stringField(toolDefinition, "name"))
      : undefined;
  const headline = base ?? "Run a tool";
  const title =
    typeof toolArguments === "object" && toolArguments !== null
      ? stringField(toolArguments, "title")
      : undefined;
  return title === undefined ? headline : `${headline}: "${title}"`;
}

/**
 * Resolves a page of pending `approval` rows into the display-safe view
 * model a human approves or rejects. Every name is looked up through the
 * definition/tenant the approval's own foreign keys already point at --
 * `workflow_run.definitionId -> workflow_definition.name` for "which agent
 * is asking" and `approval.tenantId -> tenant.name` for "in which bench" --
 * so no new naming concept is introduced, only a read of names that already
 * exist on the rows the approval is anchored to.
 */
export async function hydrateNeedsYou(
  db: DBExecutor,
  approvals: readonly ApprovalRow[],
): Promise<NeedsYouItem[]> {
  if (approvals.length === 0) return [];

  const tenantIds = [...new Set(approvals.map((row) => row.tenantId))];
  const runIds = [...new Set(approvals.map((row) => row.runId))];

  const [tenants, runs] = await Promise.all([
    db.query.tenant.findMany({ where: inArray(schema.tenant.id, tenantIds) }),
    db.query.workflowRun.findMany({
      where: inArray(schema.workflowRun.id, runIds),
    }),
  ]);

  const tenantNameById = new Map(tenants.map((row) => [row.id, row.name]));
  const definitionIdByRunId = new Map(
    runs.map((row) => [row.id, row.definitionId]),
  );
  const definitionIds = [...new Set(definitionIdByRunId.values())];
  const definitions =
    definitionIds.length === 0
      ? []
      : await db.query.workflowDefinition.findMany({
          where: inArray(schema.workflowDefinition.id, definitionIds),
        });
  const definitionNameById = new Map(
    definitions.map((row) => [row.id, row.name]),
  );

  return approvals.map((row) => {
    const definitionId = definitionIdByRunId.get(row.runId);
    const agentName =
      (definitionId !== undefined
        ? definitionNameById.get(definitionId)
        : undefined) ?? "An agent";
    const benchName = tenantNameById.get(row.tenantId) ?? "A bench";
    return {
      id: row.id,
      agentName,
      benchName,
      headline: headlineFor(row.toolDefinition, row.toolArguments),
      arguments: row.toolArguments as object,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
