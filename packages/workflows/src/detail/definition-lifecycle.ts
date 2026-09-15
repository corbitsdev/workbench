// Pure lifecycle derivation for a workflow definition's asset — the
// question `GET .../detail` (`./detail-route.ts`) exists to answer: is
// this thing runnable right now, and if not, what stage is it stuck at?
//
// Native rows carry no "lifecycle" column of their own — `workflow_model.md`
// keys `workflow_definition` on `(asset_id, wire_hash)`, so a redeploy mints
// a new row rather than mutating one. What a person needs is a single
// reading of the newest row for the asset, derived from native rows alone
// (CL-7591 cut over off the deleted Workbench durability store: native
// deployments/triggers are the only deploy-attempt signal). Kept in
// its own module, with no DB import, so the states below are covered by a
// plain unit test rather than a route fixture.
import { isFrozen } from "../launchable/target-rule";

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
  /** The rest of the same freeze, alongside `approvedWireHash` — folded
   * into `isFrozen` below rather than read alone. */
  readonly grantSnapshot: unknown;
  readonly wireProjection: unknown;
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
 * order) — native rows only.
 *
 * - No rows → `source-only`: nothing has ever produced a definition row
 *   for this asset. (The native cutover removed the Workbench
 *   deploy-attempt signal, so a failed deploy leaves no rows and reads
 *   the same as never-attempted. `build-failed` stays in the
 *   `WorkflowLifecycle` union only as wire/UI shape compatibility — the
 *   route no longer produces it.)
 * - Rows exist: the newest one decides. Not yet frozen (see `isFrozen`) →
 *   `pending-approval`. Frozen and `status: "deployed"` → `deployed`.
 *   Frozen but rolled back / replaced (`status: "stopped"`) →
 *   `superseded`.
 */
export function deriveWorkflowLifecycle(
  rows: readonly DefinitionLifecycleRow[],
): WorkflowLifecycleResult {
  if (rows.length === 0) {
    return {
      lifecycle: "source-only",
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

  if (!isFrozen(newest)) {
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
