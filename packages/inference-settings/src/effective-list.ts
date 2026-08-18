// Pure derivation of the Inference section's row list from the two reads
// `api.ts` makes: the resolved catalog (`getResolvedCatalog`) and this
// tenant's own offering ids (`listOwnOfferingIds`). Kept apart from the
// fetch and the component so the ordering/provenance logic is covered by
// a plain unit test, no DOM or network stub required.

import type { ModelInfo, ModelOfferingResponse } from "@intx/types";
import { PROVIDER_TEST_CONFIG } from "@workbench/hub-client/credential-test";

/**
 * The provider's own display name (e.g. "Ollama (local)", "Opencode Zen")
 * for a catalog row's `providerName`, which is the internal slug the
 * catalog stores it under (e.g. `"ollama"`, `"opencode-zen"`) — never a
 * name a person should read as-is. Falls back to the raw slug for a
 * provider `PROVIDER_TEST_CONFIG` doesn't know about (a custom
 * bring-your-own-key provider a workbench minted under a name of its own
 * choosing), so an unrecognized provider still renders something rather
 * than nothing.
 */
export function providerDisplayName(providerName: string): string {
  const config = (
    PROVIDER_TEST_CONFIG as Readonly<Record<string, { displayName: string }>>
  )[providerName];
  return config?.displayName ?? providerName;
}

export type DefaultProviderModel = {
  readonly canonicalName: string;
  readonly displayName: string | null;
};

/**
 * The one model a connected provider's settings row shows inline — CL-6258
 * collapsed "which model does this provider default to" to exactly this:
 * the resolved catalog's own resolution-priority order (lowest `priority`
 * number wins, `vendor/intx/db/src/model-source-resolution.ts`'s
 * `byPriority`), never a second, hand-maintained notion of a provider's
 * default. A provider can serve more than one model across the resolved
 * catalog (BYOK shadowing, a curated multi-model seed); this picks
 * whichever single offering would actually win resolution first. `null`
 * when the provider serves no offering at all (nothing resolved, or it
 * offers nothing this tenant can see).
 */
export function defaultModelForProvider(
  models: readonly ModelInfo[],
  providerName: string,
): DefaultProviderModel | null {
  let best: (DefaultProviderModel & { priority: number }) | null = null;
  for (const model of models) {
    for (const offering of model.offerings) {
      if (offering.providerName !== providerName) continue;
      if (best === null || offering.priority < best.priority) {
        best = {
          canonicalName: model.canonicalName,
          displayName: model.displayName ?? null,
          priority: offering.priority,
        };
      }
    }
  }
  return best === null
    ? null
    : { canonicalName: best.canonicalName, displayName: best.displayName };
}

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

export type PriorityPatch = {
  readonly offeringId: string;
  readonly priority: number;
};

/**
 * The two `updateOwnOffering` priority patches a "move up"/"move down"
 * reorder sends. A plain swap of the two rows' existing priorities
 * (`byPriority`'s ordering rule, `vendor/intx/db/src/model-source-resolution.ts`)
 * is a no-op whenever they tie — which every seed-created or
 * priority-omitted offering does, since the route defaults `priority` to
 * `0` — so this always assigns two *distinct* integers instead, using the
 * fixed neighbors just outside the swapped pair (if any) as bounds so the
 * pair's new priorities cannot cross into a row this call did not touch.
 * `model` is the full per-model row list in current resolution order
 * (`rowsByModel`'s value); `index`/`direction` name which adjacent pair to
 * swap. Returns `null` when there is no row to swap into (`index` is
 * already at that edge) or either side of the pair is `"inherited"` — an
 * inherited row cannot be PATCHed until it is shadowed
 * (`shadowOffering`), so a caller never sends a patch for one.
 */
export function computeReorderPatches(
  model: readonly EffectiveInferenceRow[],
  index: number,
  direction: "up" | "down",
): readonly [PriorityPatch, PriorityPatch] | null {
  const otherIndex = direction === "up" ? index - 1 : index + 1;
  const moved = model[index];
  const neighbor = model[otherIndex];
  if (moved === undefined || neighbor === undefined) return null;
  if (moved.provenance !== "set-here" || neighbor.provenance !== "set-here") {
    return null;
  }

  const lowIndex = Math.min(index, otherIndex);
  const highIndex = Math.max(index, otherIndex);
  const lowerBound = model[lowIndex - 1]?.priority;
  const upperBound = model[highIndex + 1]?.priority;

  // After the swap, whichever row now sits in the earlier position needs
  // the smaller priority; the other, the larger one.
  const [earlier, later] =
    direction === "up" ? [moved, neighbor] : [neighbor, moved];

  let earlierPriority: number;
  let laterPriority: number;
  if (lowerBound !== undefined && upperBound !== undefined) {
    const gap = upperBound - lowerBound;
    if (gap >= 3) {
      earlierPriority = lowerBound + 1;
      laterPriority = upperBound - 1;
    } else if (gap >= 1) {
      // Not enough integer room to stay strictly inside the fixed
      // neighbors' priorities — sit on the boundary values themselves
      // (tying with a fixed neighbor id-tiebreaks, same as today) rather
      // than spill past them.
      earlierPriority = lowerBound;
      laterPriority = upperBound;
    } else {
      earlierPriority = lowerBound;
      laterPriority = lowerBound + 1;
    }
  } else if (lowerBound !== undefined) {
    earlierPriority = lowerBound + 1;
    laterPriority = lowerBound + 2;
  } else if (upperBound !== undefined) {
    laterPriority = upperBound - 1;
    earlierPriority = upperBound - 2;
  } else {
    const base = Math.min(moved.priority, neighbor.priority);
    earlierPriority = base;
    laterPriority = base + 1;
  }

  return [
    { offeringId: earlier.offeringId, priority: earlierPriority },
    { offeringId: later.offeringId, priority: laterPriority },
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
