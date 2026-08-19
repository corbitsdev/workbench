// Derives a workbench host's inference preference list from the bench
// it is launching into, replacing the single hub-wide constant
// `apps/hub` used to hand every tenant regardless of which providers
// that tenant actually has credentials for. A bench whose only
// connected provider is, say, OpenRouter got a preference list naming
// only anthropic under the old constant — a workbench host that could
// never resolve a source, and (per `routes.ts`'s doc on
// `workbenchHostInferencePreferences`) failed loud at every workbench
// creation. Deriving per tenant, per creation, fixes that without
// touching the loud-failure behavior itself: a bench with no usable
// provider still gets an empty list, and `buildWorkbenchHostWorkflow` /
// the deploy-time catalog resolution downstream of it still fail loud
// on that, exactly as before.
import { listVisibleOfferings, listVisibleProviders, type DB } from "@intx/db";
import type { InferencePreference } from "@intx/agent";

/** Reads back the provider names a tenant (or an ancestor it inherits
 * catalog rows from) actually has a usable credential for. */
export type ConnectedProviderLister = (
  tenantId: string,
) => Promise<readonly string[]>;

export type DefaultInferencePreferenceLister = (
  tenantId: string,
) => Promise<readonly InferencePreference[]>;

/**
 * The `@intx/db`-backed `ConnectedProviderLister`: a provider counts as
 * connected when the tenant's visible catalog (own rows, or inherited
 * and not shadowed/disabled — see `listVisibleProviders`) carries a row
 * for it with a resolvable credential. Wallet-backed rows are excluded
 * — not launchable in this credential-backed-only release, so listing
 * one here would only earn it a spot in the preference list it can
 * never actually serve.
 */
export async function listConnectedProviders(
  db: DB["db"],
  tenantId: string,
): Promise<readonly string[]> {
  const providers = await listVisibleProviders(db, tenantId);
  return providers
    .filter((entry) => entry.row.credentialId !== null)
    .map((entry) => entry.row.name);
}

/**
 * Reads one real default model and its compatible provider fallbacks from the
 * tenant-visible catalog. The lowest-priority offering chooses the model;
 * remaining offerings of that exact canonical model form the fallback chain.
 */
export async function listDefaultInferencePreferences(
  db: DB["db"],
  tenantId: string,
): Promise<readonly InferencePreference[]> {
  const offerings = (await listVisibleOfferings(db, tenantId))
    .filter((entry) => entry.provider.credentialId !== null)
    .sort(
      (left, right) =>
        left.offering.priority - right.offering.priority ||
        left.model.canonicalName.localeCompare(right.model.canonicalName) ||
        left.provider.name.localeCompare(right.provider.name) ||
        left.offering.id.localeCompare(right.offering.id),
    );
  const defaultModel = offerings[0]?.model.canonicalName;
  if (defaultModel === undefined) return [];
  return offerings
    .filter((entry) => entry.model.canonicalName === defaultModel)
    .map((entry) => ({
      provider: entry.provider.name,
      model: entry.model.canonicalName,
    }));
}

/**
 * Builds the per-tenant resolver `routes.ts`'s `createWorkbench` handler
 * calls on every workbench creation. Takes the provider lookup as a
 * dependency (rather than a `db` handle directly) so the ordering rule
 * in `deriveWorkbenchHostInferencePreferences` — curated default per
 * connected provider, anthropic first when connected — stays testable
 * against a plain in-memory list of provider names, with no database
 * required.
 */
export function createWorkbenchHostInferencePreferencesResolver(
  listDefaults: DefaultInferencePreferenceLister,
): (tenantId: string) => Promise<readonly InferencePreference[]> {
  return async (tenantId) => listDefaults(tenantId);
}
