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
  InferenceSettingsApiError,
  type FetchImpl,
} from "@corbits/inference-settings/api";

import type { ConfigProfileEntry, ConfigProfileStore } from "./store";

export class ConfigProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`config profile ${profileId} not found`);
  }
}

/** Thrown when the target tenant's native catalog routes answer 403 to
 * one of `applyProfile`'s own resolve reads — the caller cannot touch that
 * workbench's catalog, and the route layer maps this to a plain 403
 * response rather than an opaque 500. */
export class ConfigProfileForbiddenError extends Error {}

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
    }
  | {
      readonly provider: string;
      readonly model: string;
      readonly action: "failed";
      readonly offeringId: string;
      readonly message: string;
      readonly status?: number;
    }
  | {
      readonly provider: string;
      readonly model: string;
      readonly action: "not-attempted";
      readonly offeringId: string;
    };

/**
 * Pure planning step: for each profile entry, in order, decide the native
 * write it becomes (or why it can't become one yet). `priority` is the
 * entry's own index *within its own model's entries* — a profile can list
 * entries for more than one model, and each model's fallback order is
 * independent, so two entries for different models must never tie (or
 * fall to an id-tiebreak against some untouched offering on that other
 * model) just because they happened to share a global list position. The
 * same small-integer-priority convention `@corbits/inference-settings`'s
 * `swapPriority` documents, just scoped per model. Kept apart from
 * `applyProfile` so the decision logic is covered by a plain unit test, no
 * fake fetch required.
 */
export function planApply(
  entries: readonly ConfigProfileEntry[],
  effectiveRows: readonly EffectiveInferenceRow[],
): readonly ApplyEntryResult[] {
  const priorityByModel = new Map<string, number>();
  return entries.map((entry) => {
    const priority = priorityByModel.get(entry.model) ?? 0;
    priorityByModel.set(entry.model, priority + 1);

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
      priority,
      disabled: entry.disabled ?? false,
    };
  });
}

export interface ApplyProfileResult {
  readonly profileId: string;
  readonly profileName: string;
  /** False the moment any `"reordered"` step's PATCH fails — the caller
   * (`routes.ts`) uses this to pick the response status; `results` still
   * carries every entry's own outcome either way, including what
   * succeeded before the failure and what was never attempted after it. */
  readonly ok: boolean;
  readonly results: readonly ApplyEntryResult[];
}

export interface ApplyProfileInput {
  /** The workspace tenant the profile itself belongs to. */
  readonly tenantId: string;
  readonly profileId: string;
  /** The tenant the profile's writes are applied to. */
  readonly targetTenantId: string;
  /** Bound to the hub's own base URL and the acting principal's session
   * cookie by the route layer (`routes.ts`'s `selfFetch`); defaults to the
   * global `fetch` for callers already running same-origin (tests). */
  readonly fetchImpl?: FetchImpl;
}

function messageAndStatus(cause: unknown): {
  message: string;
  status?: number;
} {
  if (cause instanceof InferenceSettingsApiError) {
    return cause.status !== undefined
      ? { message: cause.message, status: cause.status }
      : { message: cause.message };
  }
  return { message: cause instanceof Error ? cause.message : String(cause) };
}

/**
 * The two resolve reads every plan (dry-run or applied) starts from,
 * flattened to `EffectiveInferenceRow`s. Shared by `planApplyProfile` and
 * `applyProfile` so a 403 from the target tenant's native catalog routes
 * is mapped to `ConfigProfileForbiddenError` exactly once, not
 * re-implemented at each call site.
 */
async function resolveEffectiveRows(
  targetTenantId: string,
  fetchImpl: FetchImpl,
): Promise<readonly EffectiveInferenceRow[]> {
  try {
    const [models, ownOfferings] = await Promise.all([
      getResolvedCatalog(targetTenantId, fetchImpl),
      listOwnOfferings(targetTenantId, fetchImpl),
    ]);
    return buildEffectiveInferenceRows(
      models,
      new Set(ownOfferings.map((offering) => offering.id)),
    );
  } catch (cause) {
    if (cause instanceof InferenceSettingsApiError && cause.status === 403) {
      throw new ConfigProfileForbiddenError(cause.message);
    }
    throw cause;
  }
}

export interface PlanApplyProfileInput {
  /** The workspace tenant the profile itself belongs to. */
  readonly tenantId: string;
  readonly profileId: string;
  /** The tenant the plan is computed against. */
  readonly targetTenantId: string;
  readonly fetchImpl?: FetchImpl;
}

export interface PlanApplyProfileResult {
  readonly profileId: string;
  readonly profileName: string;
  readonly results: readonly ApplyEntryResult[];
}

/**
 * Read-only dry run of what `applyProfile` would do: the same resolve
 * reads and the same `planApply` decision logic, but no `updateOwnOffering`
 * PATCH ever issued. Backs the honest preview `ApplyProfilePanel` renders
 * before a person presses Apply.
 */
export async function planApplyProfile(
  deps: { readonly store: ConfigProfileStore },
  input: PlanApplyProfileInput,
): Promise<PlanApplyProfileResult> {
  const profile = await deps.store.getProfile(input.tenantId, input.profileId);
  if (profile === undefined) {
    throw new ConfigProfileNotFoundError(input.profileId);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const effectiveRows = await resolveEffectiveRows(
    input.targetTenantId,
    fetchImpl,
  );
  return {
    profileId: profile.id,
    profileName: profile.name,
    results: planApply(profile.entries, effectiveRows),
  };
}

/**
 * Resolves the target tenant's current catalog, plans the write sequence
 * (`planApply`), then issues each `"reordered"` step's `updateOwnOffering`
 * PATCH sequentially, in the profile's own entry order — never
 * `Promise.all`, so the exact call sequence a test (or an operator reading
 * the audit log) observes is deterministic and matches the profile's own
 * order one-for-one.
 *
 * The resolve reads (`getResolvedCatalog`/`listOwnOfferings`) throwing a
 * 403 means the caller cannot touch that tenant's catalog at all —
 * reported as `ConfigProfileForbiddenError`, mapped to a plain 403 by the
 * route layer, never a bare 500. A PATCH failing partway through the
 * write sequence never discards the entries that already succeeded, or
 * silently drops the ones after it: it stops issuing further writes, the
 * failing step is reported `"failed"` with its cause, and every
 * `"reordered"` step after it is reported `"not-attempted"` — the caller
 * gets the full, honest per-entry report either way.
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
  const effectiveRows = await resolveEffectiveRows(
    input.targetTenantId,
    fetchImpl,
  );

  const plan = planApply(profile.entries, effectiveRows);
  const results: ApplyEntryResult[] = [];
  let ok = true;
  let failed = false;
  for (const step of plan) {
    if (step.action !== "reordered") {
      results.push(step);
      continue;
    }
    if (failed) {
      results.push({
        provider: step.provider,
        model: step.model,
        action: "not-attempted",
        offeringId: step.offeringId,
      });
      continue;
    }
    try {
      await updateOwnOffering(
        input.targetTenantId,
        step.offeringId,
        { priority: step.priority, disabled: step.disabled },
        fetchImpl,
      );
      results.push(step);
    } catch (cause) {
      failed = true;
      ok = false;
      const { message, status } = messageAndStatus(cause);
      results.push({
        provider: step.provider,
        model: step.model,
        action: "failed",
        offeringId: step.offeringId,
        message,
        ...(status !== undefined ? { status } : {}),
      });
    }
  }

  return { profileId: profile.id, profileName: profile.name, ok, results };
}
