// Applying a profile to a workbench: a profile is a MACRO, never a
// parallel resolution path. This module resolves the target workbench's
// *current* catalog (`@corbits/inference-settings`'s own resolved-catalog
// + own-offerings reads, and its `buildEffectiveInferenceRows` provenance
// logic) and issues the exact same native writes a person would make by
// hand in the Inference section — `updateOwnOffering`'s
// `PATCH .../catalog/offerings/:id` for priority/disabled — never a
// second, duplicated write path. After apply, the workbench's own catalog
// rows ARE the config; nothing here is read back at inference time, and a
// later local reorder or restrict always wins over what a profile once set.
//
// A profile entry can only ever be reordered/restricted when the
// (provider, model) pair it names already resolves as a "set-here" row on
// the target workbench — one this exact workbench owns directly, per
// `EffectiveInferenceRow.provenance`. An *inherited* match is the "row
// needs minting" case `updateOwnOffering`'s own doc comment describes:
// `@corbits/inference-settings`'s `shadowOffering` is the one write that
// can bring it under direct control, but `shadowOffering` mints a
// brand-new, tenant-owned credential from an `apiKey` this module is never
// given — a profile's own `{provider, model, disabled?}` entries deliberately
// carry no secret material (see `store.ts`'s `ConfigProfileEntry`), and
// this package has no business collecting or storing one on a workspace-
// level preset. So an inherited match is reported back as
// `"skipped-inherited"`, not silently minted with an invented key: the
// person applying the profile brings their own key for that provider
// first (the Inference section's existing "Bring your own key" flow),
// then a re-apply picks it up as "set-here".
import {
  buildEffectiveInferenceRows,
  type EffectiveInferenceRow,
} from "@corbits/inference-settings/effective-list";
import {
  getResolvedCatalog,
  listOwnOfferings,
  updateOwnOffering,
  type FetchImpl,
} from "@corbits/inference-settings/api";

import type { ConfigProfileEntry, ConfigProfileStore } from "./store";

export class ConfigProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`config profile ${profileId} not found`);
  }
}

export type ApplyEntryResult =
  | {
      readonly provider: string;
      readonly model: string;
      readonly action: "reordered";
      readonly offeringId: string;
      readonly priority: number;
      readonly disabled: boolean;
    }
  | {
      readonly provider: string;
      readonly model: string;
      readonly action: "skipped-inherited";
    }
  | {
      readonly provider: string;
      readonly model: string;
      readonly action: "skipped-unavailable";
    };

/**
 * Pure planning step: for each profile entry, in order, decide the native
 * write it becomes (or why it can't become one yet). `priority` is the
 * entry's own index — a profile's order IS the fallback order it wants,
 * the same small-integer-priority convention
 * `@corbits/inference-settings`'s `swapPriority` documents. Kept apart
 * from `applyProfile` so the decision logic is covered by a plain unit
 * test, no fake fetch required.
 */
export function planApply(
  entries: readonly ConfigProfileEntry[],
  effectiveRows: readonly EffectiveInferenceRow[],
): readonly ApplyEntryResult[] {
  return entries.map((entry, index) => {
    const match = effectiveRows.find(
      (row) =>
        row.providerName === entry.provider &&
        row.canonicalName === entry.model,
    );
    if (match === undefined) {
      return {
        provider: entry.provider,
        model: entry.model,
        action: "skipped-unavailable",
      };
    }
    if (match.provenance !== "set-here") {
      return {
        provider: entry.provider,
        model: entry.model,
        action: "skipped-inherited",
      };
    }
    return {
      provider: entry.provider,
      model: entry.model,
      action: "reordered",
      offeringId: match.offeringId,
      priority: index,
      disabled: entry.disabled ?? false,
    };
  });
}

export interface ApplyProfileResult {
  readonly profileId: string;
  readonly profileName: string;
  readonly results: readonly ApplyEntryResult[];
}

export interface ApplyProfileInput {
  /** The workspace tenant the profile itself belongs to. */
  readonly tenantId: string;
  readonly profileId: string;
  readonly workbenchTenantId: string;
  /** Bound to the hub's own base URL and the acting principal's session
   * cookie by the route layer (`routes.ts`'s `selfFetch`); defaults to the
   * global `fetch` for callers already running same-origin (tests). */
  readonly fetchImpl?: FetchImpl;
}

/**
 * Resolves the target workbench's current catalog, plans the write
 * sequence (`planApply`), then issues each `"reordered"` step's
 * `updateOwnOffering` PATCH sequentially, in the profile's own entry
 * order — never `Promise.all`, so the exact call sequence a test (or an
 * operator reading the audit log) observes is deterministic and matches
 * the profile's own order one-for-one.
 */
export async function applyProfile(
  deps: { readonly store: ConfigProfileStore },
  input: ApplyProfileInput,
): Promise<ApplyProfileResult> {
  const profile = await deps.store.getProfile(input.tenantId, input.profileId);
  if (profile === undefined) {
    throw new ConfigProfileNotFoundError(input.profileId);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const [models, ownOfferings] = await Promise.all([
    getResolvedCatalog(input.workbenchTenantId, fetchImpl),
    listOwnOfferings(input.workbenchTenantId, fetchImpl),
  ]);
  const effectiveRows = buildEffectiveInferenceRows(
    models,
    new Set(ownOfferings.map((offering) => offering.id)),
  );

  const plan = planApply(profile.entries, effectiveRows);
  for (const step of plan) {
    if (step.action !== "reordered") continue;
    await updateOwnOffering(
      input.workbenchTenantId,
      step.offeringId,
      { priority: step.priority, disabled: step.disabled },
      fetchImpl,
    );
  }

  return { profileId: profile.id, profileName: profile.name, results: plan };
}
