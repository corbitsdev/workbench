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

function headlineFor(toolDefinition: unknown): string {
  if (
    typeof toolDefinition === "object" &&
    toolDefinition !== null &&
    "name" in toolDefinition &&
    typeof (toolDefinition as { name: unknown }).name === "string"
  ) {
    return (toolDefinition as { name: string }).name;
  }
  return "Run a tool";
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
      headline: headlineFor(row.toolDefinition),
      arguments: row.toolArguments as object,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
