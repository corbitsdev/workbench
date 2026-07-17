import { and, eq, inArray } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { generateId } from "@intx/hub-common";
import { schema as intxSchema } from "@intx/db";
import {
  pushSourceUpdatesSubtree,
  type SidecarRouter,
} from "@intx/hub-sessions";
import { FULL_CATALOG } from "@workbench/catalog";
import type { HubDb } from "../db";

const log = getLogger(["services", "catalog-provider-seed"]);
const { model, modelProvider, modelOffering } = intxSchema;

// The subset of HubDb methods a reconcile needs; also satisfied by a
// transaction handle, so the body runs identically inside `db.transaction`.
type CatalogWriter = Pick<HubDb, "query" | "insert" | "update" | "delete">;

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

type ModelPlugin =
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "google-genai";

async function reconcileProvider(
  tx: CatalogWriter,
  tenantId: string,
  providerName: string,
  plugin: ModelPlugin,
  credentialId: string,
  baseURL: string,
  now: Date,
  result: ReconcileProviderCatalogResult,
): Promise<string> {
  const existing = await tx.query.modelProvider.findFirst({
    where: and(
      eq(modelProvider.tenantId, tenantId),
      eq(modelProvider.name, providerName),
    ),
    columns: { id: true, credentialId: true },
  });
  if (existing) {
    if (existing.credentialId !== credentialId) {
      // Bind (or rebind) to the Owner-set credential. walletId is nulled
      // explicitly: model_provider enforces a credential/wallet XOR, so a
      // previously wallet-backed row would violate the check if only
      // credentialId were set.
      await tx
        .update(modelProvider)
        .set({ credentialId, walletId: null, baseURL, updatedAt: now })
        .where(eq(modelProvider.id, existing.id));
      result.credentialBound = true;
    }
    return existing.id;
  }

  const id = generateId("modelProvider");
  const [created] = await tx
    .insert(modelProvider)
    .values({
      id,
      tenantId,
      name: providerName,
      plugin,
      baseURL,
      credentialId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: modelProvider.id });
  if (created) {
    result.providerSeeded = true;
    return created.id;
  }
  // Lost a concurrent insert race; the winner's row is now committed-visible.
  const raced = await tx.query.modelProvider.findFirst({
    where: and(
      eq(modelProvider.tenantId, tenantId),
      eq(modelProvider.name, providerName),
    ),
    columns: { id: true },
  });
  if (!raced)
    throw new Error("model_provider row missing after insert conflict");
  return raced.id;
}

async function ensureModel(
  tx: CatalogWriter,
  tenantId: string,
  canonicalName: string,
  now: Date,
  result: ReconcileProviderCatalogResult,
): Promise<string> {
  const existing = await tx.query.model.findFirst({
    where: and(
      eq(model.tenantId, tenantId),
      eq(model.canonicalName, canonicalName),
    ),
    columns: { id: true },
  });
  if (existing) return existing.id;

  const id = generateId("model");
  const [created] = await tx
    .insert(model)
    .values({ id, tenantId, canonicalName, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ id: model.id });
  if (created) {
    result.modelsCreated.push(canonicalName);
    return created.id;
  }
  const raced = await tx.query.model.findFirst({
    where: and(
      eq(model.tenantId, tenantId),
      eq(model.canonicalName, canonicalName),
    ),
    columns: { id: true },
  });
  if (!raced) throw new Error("model row missing after insert conflict");
  return raced.id;
}

async function ensureOffering(
  tx: CatalogWriter,
  tenantId: string,
  modelId: string,
  providerId: string,
  modelName: string,
  priority: number,
  now: Date,
  result: ReconcileProviderCatalogResult,
): Promise<void> {
  const existing = await tx.query.modelOffering.findFirst({
    where: and(
      eq(modelOffering.tenantId, tenantId),
      eq(modelOffering.modelId, modelId),
      eq(modelOffering.providerId, providerId),
    ),
    columns: { id: true, priority: true },
  });
  if (existing) {
    if (existing.priority !== priority) {
      await tx
        .update(modelOffering)
        .set({ priority, updatedAt: now })
        .where(eq(modelOffering.id, existing.id));
      result.offeringsReprioritized.push(modelName);
    }
    return;
  }

  const [created] = await tx
    .insert(modelOffering)
    .values({
      id: generateId("modelOffering"),
      tenantId,
      modelId,
      providerId,
      priority,
      deploymentTags: [],
      capabilities: [],
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: modelOffering.id });
  if (created) {
    result.offeringsCreated.push(modelName);
    return;
  }
  // Lost a race — the offering now exists; still reconcile its priority.
  const raced = await tx.query.modelOffering.findFirst({
    where: and(
      eq(modelOffering.tenantId, tenantId),
      eq(modelOffering.modelId, modelId),
      eq(modelOffering.providerId, providerId),
    ),
    columns: { id: true, priority: true },
  });
  if (raced && raced.priority !== priority) {
    await tx
      .update(modelOffering)
      .set({ priority, updatedAt: now })
      .where(eq(modelOffering.id, raced.id));
    result.offeringsReprioritized.push(modelName);
  }
}

/**
 * After an Owner sets an inference credential, materialize that provider's
 * slice of the code catalog (`@workbench/catalog`) into the tenant's
 * Interchange catalog so its models become resolvable immediately — no manual
 * admin `Seed model catalog` step.
 *
 * Scoped to the one provider, idempotent, and a no-op (`null`) for a
 * `providerName` the code catalog does not describe (a tool-only or generic
 * provider, or one whose Owner-catalog name differs from its `FULL_CATALOG`
 * provider name). All writes run in a single transaction so a mid-loop failure
 * leaves no partial catalog; concurrent key-sets converge via
 * `onConflictDoNothing` rather than racing to a unique-constraint error.
 *
 * Unlike `seed-catalog`'s create-or-skip provider step, this also (re)binds
 * `credentialId` on a pre-existing `model_provider` row — the gap that
 * otherwise strands the offering with an unresolvable or wrong credential.
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

  await db.transaction(async (tx) => {
    const now = new Date();
    const providerId = await reconcileProvider(
      tx,
      tenantId,
      providerName,
      spec.plugin,
      credentialId,
      baseURL,
      now,
      result,
    );
    for (const off of providerOfferings) {
      const modelId = await ensureModel(tx, tenantId, off.model, now, result);
      await ensureOffering(
        tx,
        tenantId,
        modelId,
        providerId,
        off.model,
        off.priority ?? 0,
        now,
        result,
      );
    }
  });

  if (didChange(result)) {
    await pushSourceUpdatesSubtree(db, sidecarRouter, tenantId);
    log.info`Reconciled catalog for provider ${providerName}: providerSeeded=${result.providerSeeded} credentialBound=${result.credentialBound} models=${result.modelsCreated.length} offerings=${result.offeringsCreated.length} reprioritized=${result.offeringsReprioritized.length}`;
  }

  return result;
}

/**
 * Removes the catalog `model_provider` rows bound to any of `credentialIds`
 * (cascading to their `model_offering` rows) so the referenced credential can
 * then be deleted — `model_provider.credentialId` is an `onDelete: "restrict"`
 * FK, so clearing an inference credential that auto-seed bound would otherwise
 * fail. Returns the number of provider rows removed. Runs against the passed
 * writer (call inside the same transaction as the credential delete).
 */
export async function clearCatalogProvidersForCredentials(
  tx: CatalogWriter,
  tenantId: string,
  credentialIds: string[],
): Promise<number> {
  if (credentialIds.length === 0) return 0;
  const removed = await tx
    .delete(modelProvider)
    .where(
      and(
        eq(modelProvider.tenantId, tenantId),
        inArray(modelProvider.credentialId, credentialIds),
      ),
    )
    .returning({ id: modelProvider.id });
  return removed.length;
}
