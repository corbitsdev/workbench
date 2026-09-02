// Pure lifecycle derivation for a workflow definition's asset — the
// question `GET .../detail` (`./detail-route.ts`) exists to answer: is
// this thing runnable right now, and if not, what stage is it stuck at?
//
// Native rows carry no "lifecycle" column of their own — `workflow_model.md`
// keys `workflow_definition` on `(asset_id, wire_hash)`, so a redeploy mints
// a new row rather than mutating one. What a person needs is a single
// reading of the newest row for the asset, folded against the one
// Workbench-owned signal native rows don't carry: whether a deploy was ever
// attempted at all (`@corbits/workflows`'s `./deploy-source`'s per-anchor-run
// record). Kept in its own module, with no DB import, so the four states
// below are covered by a plain unit test rather than a route fixture.
export type WorkflowLifecycle =
  | "source-only"
  | "pending-approval"
  | "deployed"
  | "superseded"
  | "build-failed";

/** The one row's worth of state the derivation needs — the newest
 * `workflow_definition` row for an asset, or absent entirely. */
export type DefinitionLifecycleRow = {
  readonly id: string;
  readonly wireHash: string | null;
  /** `workflow_definition_version.approved_wire_hash` for this row's
   * current version — `null` means the freeze never landed. */
  readonly approvedWireHash: string | null;
  readonly status: "deployed" | "stopped";
  /** ISO timestamp, used only to pick the newest row when more than one
   * is passed in. */
  readonly createdAt: string;
};

export type WorkflowLifecycleResult = {
  readonly lifecycle: WorkflowLifecycle;
  readonly currentDefinitionId: string | null;
  readonly wireHash: string | null;
};

/**
 * Derive an asset's lifecycle from its `workflow_definition` rows (any
 * order) and whether a deploy was ever attempted for it.
 *
 * - No rows, no deploy attempt on record → `source-only`: nothing has ever
 *   tried to run this asset.
 * - No rows, a deploy attempt IS on record → `build-failed`: a deploy was
 *   asked for and never produced a definition row at all.
 * - Rows exist: the newest one decides. Unapproved (`approvedWireHash`
 *   still null) → `pending-approval`. Approved and `status: "deployed"` →
 *   `deployed`. Approved but rolled back / replaced (`status: "stopped"`)
 *   → `superseded`.
 */
export function deriveWorkflowLifecycle(
  rows: readonly DefinitionLifecycleRow[],
  hasDeployAttempt: boolean,
): WorkflowLifecycleResult {
  if (rows.length === 0) {
    return {
      lifecycle: hasDeployAttempt ? "build-failed" : "source-only",
      currentDefinitionId: null,
      wireHash: null,
    };
  }

  // A tie on `createdAt` (redeploys can mint rows in the same request, at
  // timestamp granularity that doesn't separate them) breaks on `id` so
  // "newest" is a deterministic total order, never array-input-order.
  const newest = [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  })[0];
  if (newest === undefined) {
    throw new Error("deriveWorkflowLifecycle: unreachable — rows non-empty");
  }

  if (newest.approvedWireHash === null) {
    return {
      lifecycle: "pending-approval",
      currentDefinitionId: newest.id,
      wireHash: newest.wireHash,
    };
  }

  return {
    lifecycle: newest.status === "deployed" ? "deployed" : "superseded",
    currentDefinitionId: newest.id,
    wireHash: newest.wireHash,
  };
}
