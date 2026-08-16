// "Save current setup as a profile": reads a workbench's effective
// ordered model/provider list — the exact same read
// `@corbits/inference-settings`'s `InferenceSection` renders from
// (`getResolvedCatalog` + `listOwnOfferings`, flattened by
// `buildEffectiveInferenceRows`) — and turns it into a profile's ordered
// `{provider, model}` entries. Only the *effective* (resolvable) rows are
// captured; a restricted offering carries no `canonicalName`/`providerName`
// of its own in `ModelOfferingResponse` (only `modelId`/`providerId`), so
// capturing it would need a second own-models/own-providers lookup this
// package has no other use for — out of scope for this workstream. A
// captured profile's entries are never given `disabled: true`; restricting
// an offering is left to a person editing the profile afterward (or the
// Inference section directly).
import { buildEffectiveInferenceRows } from "@corbits/inference-settings/effective-list";
import type { FetchImpl, ModelInfo } from "@corbits/inference-settings/api";
import {
  getResolvedCatalog,
  listOwnOfferings,
} from "@corbits/inference-settings/api";

import type {
  ConfigProfileEntry,
  ConfigProfileRow,
  ConfigProfileStore,
} from "./store";

/**
 * Pure derivation of a profile's entries from a workbench's resolved
 * catalog: one entry per (model, offering), in the same order
 * `buildEffectiveInferenceRows` already produces (model order, then each
 * model's own fallback-priority order). Kept apart from
 * `captureProfileFromWorkbench` so it is covered by a plain unit test, no
 * fake fetch required.
 */
export function buildProfileEntriesFromWorkbench(
  models: readonly ModelInfo[],
  ownOfferingIds: ReadonlySet<string>,
): readonly ConfigProfileEntry[] {
  return buildEffectiveInferenceRows(models, ownOfferingIds).map((row) => ({
    provider: row.providerName,
    model: row.canonicalName,
  }));
}

export interface CaptureProfileInput {
  /** The workspace tenant the new profile is created under. */
  readonly tenantId: string;
  readonly workbenchTenantId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly createdBy: string;
  readonly fetchImpl?: FetchImpl;
}

export async function captureProfileFromWorkbench(
  deps: { readonly store: ConfigProfileStore },
  input: CaptureProfileInput,
): Promise<ConfigProfileRow> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const [models, ownOfferings] = await Promise.all([
    getResolvedCatalog(input.workbenchTenantId, fetchImpl),
    listOwnOfferings(input.workbenchTenantId, fetchImpl),
  ]);
  const entries = buildProfileEntriesFromWorkbench(
    models,
    new Set(ownOfferings.map((offering) => offering.id)),
  );
  return deps.store.createProfile({
    tenantId: input.tenantId,
    name: input.name,
    description: input.description ?? null,
    entries,
    createdBy: input.createdBy,
  });
}
