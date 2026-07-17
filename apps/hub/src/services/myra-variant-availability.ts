import { resolveModelSources } from "@intx/db";
import {
  getMyraVariant,
  listMyraVariants,
  resolveMyraVariant,
  type MyraVariant,
  type MyraVariantKind,
  type MyraVariantSummary,
} from "@workbench/myra";
import type { HubDb } from "../db";
import { collectSystemPrincipalGrants } from "../lib/tenant-provisioning";

/**
 * CL-3824: a Myra variant is available for a tenant when at least one catalog
 * offering for its model has a resolvable inference credential. Uses the same
 * `resolveModelSources` primitive agent launch / workflow deploy use.
 */
export async function listAvailableMyraVariants(
  db: HubDb,
  tenantId: string,
): Promise<MyraVariantSummary[]> {
  const all = listMyraVariants();
  const models = [...new Set(all.map((v) => v.model))];
  const availableModels = new Set<string>();
  // Authorize the availability probe with the system principal's grants — the
  // same credential-use authority Myra actually launches under — so a variant
  // shows available iff it would truly resolve at launch (fail-closed gate).
  const creatorGrants = await collectSystemPrincipalGrants(db, tenantId);

  await Promise.all(
    models.map(async (model) => {
      const result = await resolveModelSources(
        db,
        tenantId,
        [{ model }],
        creatorGrants,
      );
      if (result.ok) availableModels.add(model);
    }),
  );

  return all.filter((v) => availableModels.has(v.model));
}

export async function isMyraVariantAvailableForTenant(
  db: HubDb,
  tenantId: string,
  variantId: string,
): Promise<boolean> {
  const variant = getMyraVariant(variantId);
  if (!variant) return false;
  const creatorGrants = await collectSystemPrincipalGrants(db, tenantId);
  const result = await resolveModelSources(
    db,
    tenantId,
    [{ model: variant.model }],
    creatorGrants,
  );
  return result.ok;
}

/**
 * Soft-nulls stored chat/triage selections whose model is no longer launchable
 * for the tenant, without writing back. Used by GET preferences (settings UI)
 * and by lazy binding on new chat threads / triage wakes so the surface the
 * member sees matches what actually launches (CL-3824).
 */
export async function softNullUnavailableVariantSelections(
  db: HubDb,
  tenantId: string,
  prefs: { chat: string | null; triage: string | null },
): Promise<{ chat: string | null; triage: string | null }> {
  const available = await listAvailableMyraVariants(db, tenantId);
  const availableIds = new Set(available.map((v) => v.id));
  return {
    chat: prefs.chat !== null && availableIds.has(prefs.chat) ? prefs.chat : null,
    triage:
      prefs.triage !== null && availableIds.has(prefs.triage)
        ? prefs.triage
        : null,
  };
}

/**
 * Resolve which full Myra variant to launch for a surface, preferring a stored
 * selection only when that model is still launchable. Falls through to the
 * canonical default among available variants of that kind, then the first
 * available, then the catalog default (last resort when nothing is launchable).
 */
export async function resolveLaunchableMyraVariant(
  db: HubDb,
  tenantId: string,
  kind: MyraVariantKind,
  selectedId: string | null | undefined,
): Promise<MyraVariant> {
  const available = await listAvailableMyraVariants(db, tenantId);
  const ofKind = available.filter((v) => v.kind === kind);

  if (selectedId != null && ofKind.some((v) => v.id === selectedId)) {
    const chosen = getMyraVariant(selectedId);
    if (chosen && chosen.kind === kind) return chosen;
  }

  const preferred = ofKind.find((v) => v.isDefault) ?? ofKind[0] ?? undefined;
  if (preferred !== undefined) {
    const full = getMyraVariant(preferred.id);
    if (full) return full;
  }

  return resolveMyraVariant(kind, selectedId);
}
