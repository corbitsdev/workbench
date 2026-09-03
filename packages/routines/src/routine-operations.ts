// The one place a routine retarget's non-authz validation lives, shared
// by both route surfaces that can retarget a routine: `./routes.ts`'s
// tenant-session `PATCH /routines/:id` and `./workflow-routine-routes.ts`'s
// run-authenticated mirror. `rejectUnlaunchableTarget` (./routes.ts)
// already covers whether the new target resolves and is authorized for
// the acting principal; this covers the two checks `POST /routines`
// (create) also runs against a fresh target — an unsuited delivery
// workbench and an existing `input` that no longer satisfies the new
// definition's input schema — so a retarget can't silently produce a
// routine that fails at next launch the way create never could. Greybeard
// review (CL-7353): PR 555 had to patch authz into both route factories
// independently; this module is the seam that stops the next fix from
// needing the same double patch for retarget validation specifically.
// No import from `./routes` here on purpose: `./routes.ts` imports
// `validateRetarget` (and, below, `isDeliveryWorkbenchRequired`) from
// this module, so this module importing back from `./routes.ts` would be
// a cycle.
export type RetargetValidationDeps = {
  readonly deliveryWorkbenchRequired?: (
    tenantId: string,
    definitionAssetId: string,
  ) => Promise<boolean>;
  readonly validateRoutineInput?: (
    tenantId: string,
    definitionAssetId: string,
    input: Record<string, unknown>,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >;
};

export type RetargetValidationRejection = {
  readonly code: "bad_request";
  readonly userMessage: string;
};

/** Every definition defaults to workbench-required — an omitted port
 * must never change prior behavior. Shared by `./routes.ts`'s
 * tenant-session create/PATCH and `./workflow-routine-routes.ts`'s
 * run-authenticated mirror, alongside `validateRetarget` below. */
export async function isDeliveryWorkbenchRequired(
  deps: Pick<RetargetValidationDeps, "deliveryWorkbenchRequired">,
  tenantId: string,
  definitionAssetId: string,
): Promise<boolean> {
  if (deps.deliveryWorkbenchRequired === undefined) return true;
  return deps.deliveryWorkbenchRequired(tenantId, definitionAssetId);
}

/**
 * Re-runs create's delivery-workbench-required and input-schema checks
 * against a routine being retargeted at `effectiveDefinitionAssetId`,
 * using the routine's own existing `deliveryWorkbenchId`/`input` (a
 * retarget-only PATCH never asks the caller to resupply fields it isn't
 * changing). `undefined` means the retarget's non-target fields are still
 * satisfied by the new target.
 */
export async function validateRetarget(
  deps: RetargetValidationDeps,
  tenantId: string,
  effectiveDefinitionAssetId: string,
  existing: {
    readonly deliveryWorkbenchId: string | null;
    readonly input: Record<string, unknown>;
  },
): Promise<RetargetValidationRejection | undefined> {
  const deliveryRequired = await isDeliveryWorkbenchRequired(
    deps,
    tenantId,
    effectiveDefinitionAssetId,
  );
  if (deliveryRequired && existing.deliveryWorkbenchId === null) {
    return {
      code: "bad_request",
      userMessage: "deliveryWorkbenchId is required for this workflow",
    };
  }

  if (deps.validateRoutineInput !== undefined) {
    const validated = await deps.validateRoutineInput(
      tenantId,
      effectiveDefinitionAssetId,
      existing.input,
    );
    if (!validated.ok) {
      return { code: "bad_request", userMessage: validated.message };
    }
  }

  return undefined;
}
