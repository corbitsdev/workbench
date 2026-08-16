// Pure derivation of the Inference section's row list from the two reads
// `api.ts` makes: the resolved catalog (`getResolvedCatalog`) and this
// tenant's own offering ids (`listOwnOfferingIds`). Kept apart from the
// fetch and the component so the ordering/provenance logic is covered by
// a plain unit test, no DOM or network stub required.

import type { ModelInfo, ModelOfferingResponse } from "@intx/types";

export type EffectiveInferenceRow = {
  readonly offeringId: string;
  readonly modelId: string;
  readonly canonicalName: string;
  readonly modelDisplayName: string | null;
  readonly providerId: string;
  readonly providerName: string;
  readonly plugin: string;
  readonly priority: number;
  /** `"set-here"` when this exact tenant owns the offering row directly;
   * `"inherited"` when it was resolved from an ancestor tenant. */
  readonly provenance: "set-here" | "inherited";
};

/**
 * Flattens the resolved catalog to one row per (model, offering), each
 * still grouped under its model and still in the model's own
 * resolution-priority order — `ModelInfo.offerings` already arrives
 * priority-sorted (`composeDiscoveredModels`,
 * `vendor/intx/hub-api/src/routes/models.ts`), so this never re-sorts,
 * only annotates provenance by diffing each offering id against
 * `ownOfferingIds`. A row this tenant has restricted (disabled) never
 * appears here — the cascade in `listVisibleOfferings` already dropped it
 * from the resolved read — see `restrictedOfferings` for those.
 */
export function buildEffectiveInferenceRows(
  models: readonly ModelInfo[],
  ownOfferingIds: ReadonlySet<string>,
): readonly EffectiveInferenceRow[] {
  const rows: EffectiveInferenceRow[] = [];
  for (const model of models) {
    for (const offering of model.offerings) {
      rows.push({
        offeringId: offering.offeringId,
        modelId: model.id,
        canonicalName: model.canonicalName,
        modelDisplayName: model.displayName ?? null,
        providerId: offering.providerId,
        providerName: offering.providerName,
        plugin: offering.plugin,
        priority: offering.priority,
        provenance: ownOfferingIds.has(offering.offeringId)
          ? "set-here"
          : "inherited",
      });
    }
  }
  return rows;
}

/** This tenant's own offering rows it has restricted (`disabled: true`)
 * — invisible to `buildEffectiveInferenceRows` because a disabled
 * offering is cascaded out of the resolved catalog entirely, not merely
 * flagged there. Surfaced separately so restricting an offering doesn't
 * read as "it vanished" with no way back. */
export function restrictedOfferings(
  ownOfferings: readonly (typeof ModelOfferingResponse.infer)[],
): readonly (typeof ModelOfferingResponse.infer)[] {
  return ownOfferings.filter((offering) => offering.disabled);
}

/**
 * The two `updateOwnOffering` priority patches a "move up"/"move down"
 * reorder sends: swapping `moved` past its neighbor swaps their
 * priorities, the plain way `byPriority`
 * (`vendor/intx/db/src/model-source-resolution.ts`) is defined to read
 * order — never a fractional insert, so every offering in a model's
 * fallback list keeps a small integer priority. Both rows must already be
 * `"set-here"`; an inherited row cannot be PATCHed until it is shadowed,
 * so a caller filters the reorderable set to `"set-here"` rows before
 * ever computing a swap.
 */
export function swapPriority(
  moved: EffectiveInferenceRow,
  neighbor: EffectiveInferenceRow,
): readonly [
  { readonly offeringId: string; readonly priority: number },
  { readonly offeringId: string; readonly priority: number },
] {
  return [
    { offeringId: moved.offeringId, priority: neighbor.priority },
    { offeringId: neighbor.offeringId, priority: moved.priority },
  ];
}

/** Rows for one model, in fallback order, restricted to the set a caller
 * can act on directly (`"set-here"`) alongside their `"inherited"`
 * siblings — a reorder only ever targets adjacent `"set-here"` rows. */
export function rowsByModel(
  rows: readonly EffectiveInferenceRow[],
): ReadonlyMap<string, readonly EffectiveInferenceRow[]> {
  const byModel = new Map<string, EffectiveInferenceRow[]>();
  for (const row of rows) {
    const existing = byModel.get(row.modelId);
    if (existing === undefined) {
      byModel.set(row.modelId, [row]);
    } else {
      existing.push(row);
    }
  }
  return byModel;
}
