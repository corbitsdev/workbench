import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { toLlmToolName } from "@workbench/agents";

/**
 * A persisted `grant` row authorizing an instance principal to invoke a tool.
 *
 * Tool authorization in the workbench is trust-by-configuration: any tool in an
 * agent's capabilities list is allowed (origin `system`), with no per-invoker
 * delegation. Interchange's `grantRequirements` only models creator/invoker
 * delegation, so trusted infrastructure tools (e.g. exa_search) are expressed
 * as directly-created grant rows — the same way admin-ui creates grants and the
 * way Interchange materializes them to the DB at launch.
 *
 * These rows MUST be persisted (not synthesized in memory at launch): the
 * orchestrator's reconnect path re-sends only what `collectGrants` reads from
 * the DB, so in-memory tool grants are dropped on every sidecar reconnect (the
 * cause of CL-1398's "No matching grants for tool:..." failures).
 */
export type ToolGrantRow = typeof intxSchema.grant.$inferInsert;

/** The resource-string prefix every tool grant uses. */
export const TOOL_GRANT_RESOURCE_PREFIX = "tool:";

/**
 * Build the persisted grant rows for an instance principal's tool set. Tool
 * names are mapped to their LLM-safe form (`toLlmToolName`) so the grant
 * resource matches what the model actually invokes (the sidecar presents the
 * same safe name and the authz `beforeTool` check keys on `call.name`); the
 * canonical `:` name never round-trips through the model (CL-2306). Names are
 * de-duplicated after mapping; an empty list yields no rows.
 */
export function buildToolGrantRows(
  toolNames: string[],
  scope: { tenantId: string; principalId: string },
  now: Date,
): ToolGrantRow[] {
  const unique = [...new Set(toolNames.map(toLlmToolName))];
  return unique.map((name) => ({
    id: generateId("grant"),
    tenantId: scope.tenantId,
    principalId: scope.principalId,
    roleId: null,
    resource: `${TOOL_GRANT_RESOURCE_PREFIX}${name}`,
    action: "invoke",
    effect: "allow",
    conditions: null,
    origin: "system",
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  }));
}
