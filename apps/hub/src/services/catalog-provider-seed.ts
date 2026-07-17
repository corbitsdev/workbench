import { and, eq } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { generateId } from "@intx/hub-common";
import { schema as intxSchema } from "@intx/db";
import {
  pushSourceUpdatesSubtree,
  type SidecarRouter,
} from "@intx/hub-sessions";
import { FULL_CATALOG } from "@workbench/catalog";
import type { HubDb } from "../db";

const log = getLogger("catalog-provider-seed");
const { model, modelProvider, modelOffering } = intxSchema;

export type ReconcileProviderCatalogParams = {
  db: HubDb;
  sidecarRouter: SidecarRouter;
  tenantId: string;
  providerName: string;
  credentialId: string;
  baseURL: string;
};

export type ReconcileProviderCatalogResult = {
  providerSeeded: boolean;
  credentialBound: boolean;
  modelsCreated: string[];
  offeringsCreated: string[];
  offeringsReprioritized: string[];
};

function didChange(result: ReconcileProviderCatalogResult): boolean {
  return (
    result.providerSeeded ||
    result.credentialBound ||
    result.modelsCreated.length > 0 ||
    result.offeringsCreated.length > 0 ||
    result.offeringsReprioritized.length > 0
  );
}

/**
 * After an Owner sets an inference credential, materialize that provider's
 * slice of the code catalog (`@workbench/catalog`) into the tenant's
 * Interchange catalog so its models become resolvable immediately — no manual
 * admin `Seed model catalog` step.
 *
 * Scoped to the one provider, idempotent, and a no-op for a `providerName` the
 * code catalog does not describe (a tool-only or generic provider returns
 * `null`). Mirrors `seed-catalog`'s create-or-reconcile semantics and
 * additionally binds `credentialId` on a pre-existing `model_provider` row —
 * the gap `seed-catalog`'s create-or-skip leaves, which otherwise strands the
 * offering with an unresolvable credential.
 *
 * Writes at `tenantId` (the credential's tenant, i.e. root) so descendants
 * inherit via the catalog ancestor walk, matching `seed-catalog`. On any
 * mutation it re-pushes resolved sources to the tenant subtree through the
 * native Interchange primitive so live sidecars pick up the new offering.
 */
export async function reconcileProviderCatalog(
  params: ReconcileProviderCatalogParams,
): Promise<ReconcileProviderCatalogResult | null> {
  const { db, sidecarRouter, tenantId, providerName, credentialId, baseURL } =
    params;

  const spec = FULL_CATALOG.providers.find((p) => p.name === providerName);
  if (!spec) return null;

  const providerOfferings = FULL_CATALOG.offerings.filter(
    (o) => o.provider === providerName,
  );
  if (providerOfferings.length === 0) return null;

  const result: ReconcileProviderCatalogResult = {
    providerSeeded: false,
    credentialBound: false,
    modelsCreated: [],
    offeringsCreated: [],
    offeringsReprioritized: [],
  };
  const now = new Date();

  let providerRow = await db.query.modelProvider.findFirst({
    where: and(
      eq(modelProvider.tenantId, tenantId),
      eq(modelProvider.name, providerName),
    ),
    columns: { id: true, credentialId: true },
  });
  if (!providerRow) {
    const [created] = await db
      .insert(modelProvider)
      .values({
        id: generateId("modelProvider"),
        tenantId,
        name: providerName,
        plugin: spec.plugin,
        baseURL,
        credentialId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: modelProvider.id });
    if (!created) throw new Error("failed to insert model_provider row");
    providerRow = { id: created.id, credentialId };
    result.providerSeeded = true;
  } else if (providerRow.credentialId !== credentialId) {
    await db
      .update(modelProvider)
      .set({ credentialId, baseURL, updatedAt: now })
      .where(eq(modelProvider.id, providerRow.id));
    result.credentialBound = true;
  }
  const providerId = providerRow.id;

  for (const off of providerOfferings) {
    let modelRow = await db.query.model.findFirst({
      where: and(
        eq(model.tenantId, tenantId),
        eq(model.canonicalName, off.model),
      ),
      columns: { id: true },
    });
    if (!modelRow) {
      const [created] = await db
        .insert(model)
        .values({
          id: generateId("model"),
          tenantId,
          canonicalName: off.model,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: model.id });
      if (!created) throw new Error("failed to insert model row");
      modelRow = { id: created.id };
      result.modelsCreated.push(off.model);
    }

    const priority = off.priority ?? 0;
    const existingOffering = await db.query.modelOffering.findFirst({
      where: and(
        eq(modelOffering.tenantId, tenantId),
        eq(modelOffering.modelId, modelRow.id),
        eq(modelOffering.providerId, providerId),
      ),
      columns: { id: true, priority: true },
    });
    if (!existingOffering) {
      await db.insert(modelOffering).values({
        id: generateId("modelOffering"),
        tenantId,
        modelId: modelRow.id,
        providerId,
        priority,
        deploymentTags: [],
        capabilities: [],
        createdAt: now,
        updatedAt: now,
      });
      result.offeringsCreated.push(off.model);
    } else if (existingOffering.priority !== priority) {
      await db
        .update(modelOffering)
        .set({ priority, updatedAt: now })
        .where(eq(modelOffering.id, existingOffering.id));
      result.offeringsReprioritized.push(off.model);
    }
  }

  if (didChange(result)) {
    await pushSourceUpdatesSubtree(db, sidecarRouter, tenantId);
    log.info`Reconciled catalog for provider ${providerName}: providerSeeded=${result.providerSeeded} credentialBound=${result.credentialBound} models=${result.modelsCreated.length} offerings=${result.offeringsCreated.length} reprioritized=${result.offeringsReprioritized.length}`;
  }

  return result;
}
