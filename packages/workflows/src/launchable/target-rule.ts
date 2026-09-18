// The follow-latest rule, pure — no `drizzle-orm`, no `@intx/db` — so this
// half is browser-safe and testable without a database.
export type LaunchableDefinitionRejection =
  | "not_found"
  | "unfrozen"
  | "not_deployed"
  | "cross_tenant";

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

/** The columns the pick needs from one `workflow_definition` row, declared
 * as a plain shape so the ordering rule is testable without a database. */
export type LaunchableDefinitionCandidate = {
  readonly id: string;
  readonly tenantId: string;
  readonly status: string;
  readonly approvedWireHash: string | null;
  readonly grantSnapshot: unknown;
  readonly wireProjection: unknown;
  readonly createdAt: Date;
};

/** The one predicate for "did a deploy freeze land," shared by the
 * follow-latest rule and the definition-lifecycle derivation. */
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

/** The follow-latest rule: the newest row in `tenantId` that is `deployed`
 * and frozen wins. The rejection reason is the most specific the rows
 * support, so a cross-tenant reference is named as such, not "missing." */
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
  // A `createdAt` tie breaks on `id` desc for a deterministic total order.
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

/** The typed refusal a route answers with when a routine's target does not
 * resolve. A cross-tenant asset reports as not found. */
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

/** Thrown by a launcher when a routine fires and its target no longer
 * resolves — fails closed rather than running whatever row exists. */
export class RoutineTargetUnresolvableError extends Error {
  readonly reason: LaunchableDefinitionRejection;
  readonly definitionAssetId: string;
  constructor(definitionAssetId: string, reason: LaunchableDefinitionRejection) {
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
