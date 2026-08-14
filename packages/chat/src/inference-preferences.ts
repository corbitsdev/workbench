// Derives a channel host's inference preference list from the bench
// it is launching into, replacing the single hub-wide constant
// `apps/hub` used to hand every tenant regardless of which providers
// that tenant actually has credentials for. A bench whose only
// connected provider is, say, OpenRouter got a preference list naming
// only anthropic under the old constant — a channel host that could
// never resolve a source, and (per `routes.ts`'s doc on
// `channelHostInferencePreferences`) failed loud at every channel
// creation. Deriving per tenant, per creation, fixes that without
// touching the loud-failure behavior itself: a bench with no usable
// provider still gets an empty list, and `buildChannelHostWorkflow` /
// the deploy-time catalog resolution downstream of it still fail loud
// on that, exactly as before.
import { listVisibleProviders, type DB } from "@intx/db";
import type { InferencePreference } from "@intx/agent";
import { deriveChannelHostInferencePreferences } from "@workbench/hub-client";

/** Reads back the provider names a tenant (or an ancestor it inherits
 * catalog rows from) actually has a usable credential for. */
export type ConnectedProviderLister = (
  tenantId: string,
) => Promise<readonly string[]>;

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
 * Builds the per-tenant resolver `routes.ts`'s `createChannel` handler
 * calls on every channel creation. Takes the provider lookup as a
 * dependency (rather than a `db` handle directly) so the ordering rule
 * in `deriveChannelHostInferencePreferences` — curated default per
 * connected provider, anthropic first when connected — stays testable
 * against a plain in-memory list of provider names, with no database
 * required.
 */
export function createChannelHostInferencePreferencesResolver(
  listConnected: ConnectedProviderLister,
): (tenantId: string) => Promise<readonly InferencePreference[]> {
  return async (tenantId) =>
    deriveChannelHostInferencePreferences(await listConnected(tenantId));
}
