// The Routines page's "Available" section (CL-7073): every catalog
// workflow (`@corbits/seeding`'s `CATALOG_WORKFLOWS` — injected here by
// asset name so this package never depends back on `@corbits/seeding`,
// which already depends on `@corbits/workflows`) that has no deployed
// definition of that asset name on the caller's bench yet, alongside
// this package's own `WORKFLOW_CATALOG` display metadata and whether the
// tenant already satisfies its required connections.
//
// Connection satisfaction mirrors `@corbits/settings-ui`'s
// `connectorStatus` exactly (same provider-name-match, same
// active-credential rule) but reads the tables directly rather than
// importing a UI package into a domain package: a connector reads
// "satisfied" only when a `provider` row named after the connector id
// exists AND either it carries no credential yet (nothing to fail) or
// its newest credential is `active`. An `expired`/`error`/`revoked`
// credential reads as unsatisfied, the same "needs attention" case
// `connectorStatus` reports.
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { credential, provider, workflowDefinition } from "@intx/db/schema";

import { workflowCatalogEntry } from "../catalog";

export type AvailableCatalogWorkflow = {
  readonly assetName: string;
  readonly displayName: string;
  readonly description: string;
  readonly requiredConnections: readonly string[];
  readonly missingConnections: readonly string[];
  readonly connectionsSatisfied: boolean;
};

/**
 * The read-only-of-a-database-round-trip core: given which asset names
 * are already deployed and a synchronous "is this connector satisfied"
 * lookup, computes the available list. Split out from
 * `listAvailableCatalogWorkflows` so this — the actual per-entry
 * filtering and shaping logic — has a test that needs no Postgres.
 */
export function availableCatalogWorkflowsFrom(args: {
  readonly catalogAssetNames: readonly string[];
  readonly deployedNames: ReadonlySet<string>;
  readonly isConnectorSatisfied: (connectorId: string) => boolean;
}): readonly AvailableCatalogWorkflow[] {
  const { catalogAssetNames, deployedNames, isConnectorSatisfied } = args;
  const available: AvailableCatalogWorkflow[] = [];
  for (const assetName of catalogAssetNames) {
    if (deployedNames.has(assetName)) continue;
    const entry = workflowCatalogEntry(assetName);
    if (entry === undefined) continue;

    const missingConnections = entry.requiredConnections.filter(
      (connectorId) => !isConnectorSatisfied(connectorId),
    );

    available.push({
      assetName,
      displayName: entry.displayName,
      description: entry.whatItDoes,
      requiredConnections: entry.requiredConnections,
      missingConnections,
      connectionsSatisfied: missingConnections.length === 0,
    });
  }
  return available;
}

async function connectorIsSatisfied(
  db: DB["db"],
  tenantId: string,
  connectorId: string,
): Promise<boolean> {
  const providerRow = await db.query.provider.findFirst({
    where: and(eq(provider.tenantId, tenantId), eq(provider.name, connectorId)),
    columns: { id: true },
  });
  if (providerRow === undefined) return false;

  const newestCredential = await db.query.credential.findFirst({
    where: eq(credential.providerId, providerRow.id),
    orderBy: [desc(credential.createdAt)],
    columns: { status: true },
  });
  if (newestCredential === undefined) return true;
  return newestCredential.status === "active";
}

/**
 * Every catalog asset name with no deployed `workflow_definition` on this
 * tenant yet, enriched with `WORKFLOW_CATALOG` metadata and connection
 * satisfaction. `catalogAssetNames` names the full deployable-through-the-
 * -catalog-instantiate-route set (`@corbits/seeding`'s
 * `CATALOG_WORKFLOWS`, by asset name) — the caller's job, not this
 * package's, since importing that package here would cycle back through
 * its own dependency on `@corbits/workflows`. A catalog name with no
 * `WORKFLOW_CATALOG` entry is skipped rather than thrown on: the two
 * lists are asserted equal elsewhere (`packages/seeding/test`), so this
 * is defense against the caller passing a stale name, not an expected
 * path.
 */
export async function listAvailableCatalogWorkflows(args: {
  readonly db: DB["db"];
  readonly tenantId: string;
  readonly catalogAssetNames: readonly string[];
}): Promise<readonly AvailableCatalogWorkflow[]> {
  const { db, tenantId, catalogAssetNames } = args;

  const deployed = await db.query.workflowDefinition.findMany({
    where: and(
      eq(workflowDefinition.tenantId, tenantId),
      eq(workflowDefinition.origin, "authored"),
      eq(workflowDefinition.status, "deployed"),
    ),
    columns: { name: true },
  });
  const deployedNames = new Set(deployed.map((row) => row.name));

  const connectorSatisfaction = new Map<string, boolean>();
  const allConnectorIds = new Set(
    catalogAssetNames.flatMap(
      (assetName) => workflowCatalogEntry(assetName)?.requiredConnections ?? [],
    ),
  );
  for (const connectorId of allConnectorIds) {
    connectorSatisfaction.set(
      connectorId,
      await connectorIsSatisfied(db, tenantId, connectorId),
    );
  }

  return availableCatalogWorkflowsFrom({
    catalogAssetNames,
    deployedNames,
    isConnectorSatisfied: (connectorId) =>
      connectorSatisfaction.get(connectorId) ?? false,
  });
}
