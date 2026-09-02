// The follow-latest rule, pure — no `drizzle-orm`, no `@intx/db`, so this
// half of `./target.ts` is safe on `@corbits/workflows/client` and
// testable without a database. `./target.ts` is the DB-touching half
// (`resolveLaunchableDefinition`) that queries rows and hands them to
// `pickLaunchableDefinition` below.
export type LaunchableDefinitionRejection =
  "not_found" | "unfrozen" | "not_deployed" | "cross_tenant";

export type LaunchableDefinitionResolution =
  | {
      readonly ok: true;
      readonly definitionId: string;
      readonly wireHash: string;
    }
  | { readonly ok: false; readonly reason: LaunchableDefinitionRejection };

export type LaunchableDefinitionResolver = (
  tenantId: string,
  definitionAssetId: string,
) => Promise<LaunchableDefinitionResolution>;

/**
 * The columns the pick needs from one `workflow_definition` row joined
 * to its current `workflow_definition_version` — the row the deploy
 * freeze stamps `approved_wire_hash`, `grant_snapshot`, and
 * `wire_projection` onto (`@intx/db`'s `loadFrozenGrantSnapshot` reads
 * the same row). Declared as a plain shape so the ordering rule below
 * is testable without a database.
 */
export type LaunchableDefinitionCandidate = {
  readonly id: string;
  readonly tenantId: string;
  readonly status: string;
  readonly approvedWireHash: string | null;
  readonly grantSnapshot: unknown;
  readonly wireProjection: unknown;
  readonly createdAt: Date;
};

/** A deploy freeze stamps `approvedWireHash`, `grantSnapshot`, and
 * `wireProjection` onto a definition's current version atomically — this
 * is the one predicate for "did that freeze land," shared by the
 * follow-latest rule below and `../detail/definition-lifecycle.ts`'s
 * lifecycle derivation. */
export function isFrozen(candidate: {
  readonly approvedWireHash: string | null;
  readonly grantSnapshot: unknown;
  readonly wireProjection: unknown;
}): boolean {
  return (
    candidate.approvedWireHash !== null &&
    candidate.grantSnapshot !== null &&
    candidate.grantSnapshot !== undefined &&
    candidate.wireProjection !== null &&
    candidate.wireProjection !== undefined
  );
}

/**
 * The follow-latest rule, pure: among every definition row minted for
 * one asset (across tenants — the caller passes them all so a
 * cross-tenant reference can be named as such rather than read as
 * "missing"), the newest row in `tenantId` that is `deployed` AND
 * frozen wins. The rejection reason is the most specific one the rows
 * support: no rows at all → `not_found`; rows, none in this tenant →
 * `cross_tenant`; in-tenant rows, none deployed → `not_deployed`;
 * deployed rows, none frozen → `unfrozen`.
 */
export function pickLaunchableDefinition(
  candidates: readonly LaunchableDefinitionCandidate[],
  tenantId: string,
): LaunchableDefinitionResolution {
  if (candidates.length === 0) return { ok: false, reason: "not_found" };
  const inTenant = candidates.filter((row) => row.tenantId === tenantId);
  if (inTenant.length === 0) return { ok: false, reason: "cross_tenant" };
  const deployed = inTenant.filter((row) => row.status === "deployed");
  if (deployed.length === 0) return { ok: false, reason: "not_deployed" };
  const frozen = deployed.filter(isFrozen);
  if (frozen.length === 0) return { ok: false, reason: "unfrozen" };
  // Newest wins; a `createdAt` tie (redeploys minted in the same request,
  // at timestamp granularity that doesn't separate them) breaks on `id`
  // desc so the pick is a deterministic total order, never array-input
  // order — the one tiebreak this rule uses, everywhere it's used.
  const newest = [...frozen].sort((a, b) => {
    const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  })[0];
  if (newest === undefined || newest.approvedWireHash === null) {
    return { ok: false, reason: "unfrozen" };
  }
  return {
    ok: true,
    definitionId: newest.id,
    wireHash: newest.approvedWireHash,
  };
}

/**
 * The typed refusal a route answers with when a routine's target does
 * not resolve — one code per reason so a UI or Myra can branch on it,
 * and a sentence a person can act on. A cross-tenant asset is reported
 * as not found: naming another tenant's asset must not confirm it
 * exists.
 */
export function routineTargetRejection(reason: LaunchableDefinitionRejection): {
  readonly status: 404 | 409;
  readonly code: string;
  readonly userMessage: string;
} {
  switch (reason) {
    case "not_found":
    case "cross_tenant":
      return {
        status: 404,
        code: "routine_target_not_found",
        userMessage: "No workflow with that id exists in this workspace.",
      };
    case "not_deployed":
      return {
        status: 409,
        code: "routine_target_not_deployed",
        userMessage:
          "That workflow has no deployed version yet — deploy it, then point the routine at it.",
      };
    case "unfrozen":
      return {
        status: 409,
        code: "routine_target_not_approved",
        userMessage:
          "That workflow's deployment has not been approved yet — approve it, then point the routine at it.",
      };
  }
}

/**
 * Thrown by a launcher when a routine fires and its target no longer
 * resolves: the fire fails closed (recorded as a failed run by the
 * scheduler's own bookkeeping) instead of running whatever row happens
 * to exist.
 */
export class RoutineTargetUnresolvableError extends Error {
  readonly reason: LaunchableDefinitionRejection;
  readonly definitionAssetId: string;
  constructor(
    definitionAssetId: string,
    reason: LaunchableDefinitionRejection,
  ) {
    super(
      `routine target ${definitionAssetId} has no launchable definition (${reason}): ${
        routineTargetRejection(reason).userMessage
      }`,
    );
    this.name = "RoutineTargetUnresolvableError";
    this.reason = reason;
    this.definitionAssetId = definitionAssetId;
  }
}
