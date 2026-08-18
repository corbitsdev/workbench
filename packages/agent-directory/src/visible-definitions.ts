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
import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";

export type VisibleAgentDefinition = {
  readonly id: string;
  readonly name: string;
  /** The tenant that actually owns this definition — where its DM channel
   * must be minted, not necessarily the caller's own tenant. */
  readonly tenantId: string;
  /** The owning tenant's display name — lets a sidebar row honestly
   * caption an ancestor agent the caller isn't a member of ("lives in
   * <tenantName>") without a second round trip. */
  readonly tenantName: string;
  /** Recency fallback for a sidebar row that has never been opened as a
   * DM: once a DM channel exists its own `lastActivityAt` takes over. */
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
      // channel host is a silent per-channel anchor, never a DM target.
      if (row.assetId === null) continue;
      if (isChannelHostDefinitionName(row.name)) continue;
      // Leaf-to-root order means the closer tenant's definition for this
      // name was already recorded — an ancestor's same-name row never
      // overwrites it.
      if (byName.has(row.name)) continue;
      byName.set(row.name, {
        id: row.id,
        name: row.description ?? row.name,
        tenantId: tid,
        tenantName,
        createdAt: row.createdAt.toISOString(),
      });
    }
  }

  return [...byName.values()];
}
