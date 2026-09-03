// Every agent definition this tenant can open a direct chat with:
// its own, plus every ancestor's, walking the tenant ancestor chain the
// same way `@intx/db`'s own `resolveProviderByName`/`listAssetsForTenant`
// do and `packages/connections/src/mcp-server-store.ts`'s
// `listMcpServerConnections` already does for MCP server connections
// (CL-6191) — a child tenant can reach anything a parent tenant made
// available, and a same-name definition made at the child shadows the
// ancestor's. Reads inherit up the chain; creating/editing a definition
// stays own-tenant only (`./routes.ts`).
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { getAncestorChain, schema } from "@intx/db";
import { isWorkbenchHostDefinitionName } from "@corbits/chat/workbench-host-naming";
import { isConversationalWorkflowName } from "@workbench/templates";
import { deriveDisplayName } from "./client";

export type VisibleAgentDefinition = {
  readonly id: string;
  /** The definition's display name — its own description when one was
   * set at creation, otherwise a humanized reading of its immutable slug
   * (`deriveDisplayName`, CL-6413). Never the raw slug itself. */
  readonly name: string;
  /** The tenant that actually owns this definition — where its DM workbench
   * must be minted, not necessarily the caller's own tenant. */
  readonly tenantId: string;
  /** The owning tenant's display name — lets a sidebar row honestly
   * caption an ancestor agent the caller isn't a member of ("lives in
   * <tenantName>") without a second round trip. */
  readonly tenantName: string;
  /** Recency fallback for a sidebar row that has never been opened as a
   * DM: once a DM workbench exists its own `lastActivityAt` takes over. */
  readonly createdAt: string;
};

export async function listVisibleAgentDefinitions(
  db: DB["db"],
  tenantId: string,
): Promise<readonly VisibleAgentDefinition[]> {
  const chain = await getAncestorChain(db, tenantId);
  const byName = new Map<string, VisibleAgentDefinition>();
  const tenantNameById = new Map<string, string>();

  for (const tid of chain) {
    const rows = await db.query.workflowDefinition.findMany({
      where: and(
        eq(schema.workflowDefinition.tenantId, tid),
        eq(schema.workflowDefinition.status, "deployed"),
      ),
    });
    if (rows.length === 0) continue;

    let tenantName = tenantNameById.get(tid);
    if (tenantName === undefined) {
      const tenantRow = await db.query.tenant.findFirst({
        where: eq(schema.tenant.id, tid),
      });
      tenantName = tenantRow?.name ?? tid;
      tenantNameById.set(tid, tenantName);
    }

    for (const row of rows) {
      // A definition with no materialized asset isn't launchable yet; a
      // workbench host is a silent per-workbench anchor, never a DM target;
      // a seeded workflow-catalog utility (Echo, Workbench digest,
      // Recurring task, Last 30 days research, …) is a mail-triggered
      // automation, not a conversational agent — DMing it produces
      // nonsense, so only a genuinely conversational definition is listed.
      if (row.assetId === null) continue;
      if (isWorkbenchHostDefinitionName(row.name)) continue;
      if (!isConversationalWorkflowName(row.name)) continue;
      // Leaf-to-root order means the closer tenant's definition for this
      // name was already recorded — an ancestor's same-name row never
      // overwrites it.
      if (byName.has(row.name)) continue;
      byName.set(row.name, {
        id: row.id,
        name: deriveDisplayName(row),
        tenantId: tid,
        tenantName,
        createdAt: row.createdAt.toISOString(),
      });
    }
  }

  return [...byName.values()];
}
