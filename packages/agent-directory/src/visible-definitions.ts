// Every agent definition this tenant can open a direct chat with: its own,
// plus every ancestor's. A same-name definition at the child shadows the
// ancestor's. Reads inherit up the chain; create/edit stays own-tenant only.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { getAncestorChain, schema } from "@intx/db";
import { isConversationalWorkflowName } from "@corbits/workflows/catalog";
import { deriveDisplayName } from "./client";

export type VisibleAgentDefinition = {
  readonly id: string;
  /** The definition's display name — its own description when one was
   * set at creation, otherwise a humanized reading of its immutable slug
   * (`deriveDisplayName`). Never the raw slug itself. */
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
      // An unmaterialized asset isn't launchable; a workbench host or a
      // mail-triggered catalog utility isn't a DM target.
      if (row.assetId === null) continue;
      if (!isConversationalWorkflowName(row.name)) continue;
      // Leaf-to-root order: an ancestor's same-name row never overwrites.
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
