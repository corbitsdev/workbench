// The one place a routine's target (a workflow asset id) becomes the
// definition that actually runs. Interchange keys `workflow_definition`
// on `(asset_id, wire_hash)` and has no "newest approved deployment of
// this asset" indirection of its own (docs/workflow-model.md), so this
// module supplies exactly that query — and nothing else: no search by
// name, no fallback to an unfrozen row, no pinning. Every caller (create,
// retarget, launch) resolves through here so a routine can never run a
// definition this rule would not have picked.
import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { workflowDefinition, workflowDefinitionVersion } from "@intx/db/schema";

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

function isFrozen(candidate: LaunchableDefinitionCandidate): boolean {
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
  const newest = [...frozen].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];
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
 * Resolves the definition a routine targeting `definitionAssetId` would
 * run right now, per `pickLaunchableDefinition`. One query, read at the
 * moment of use — a create/retarget validates through it, and a launch
 * re-resolves through it rather than trusting anything stored.
 */
export async function resolveLaunchableDefinition(input: {
  db: PostgresJsDatabase<Record<string, unknown>>;
  tenantId: string;
  definitionAssetId: string;
}): Promise<LaunchableDefinitionResolution> {
  const rows = await input.db
    .select({
      id: workflowDefinition.id,
      tenantId: workflowDefinition.tenantId,
      status: workflowDefinition.status,
      createdAt: workflowDefinition.createdAt,
      approvedWireHash: workflowDefinitionVersion.approvedWireHash,
      grantSnapshot: workflowDefinitionVersion.grantSnapshot,
      wireProjection: workflowDefinitionVersion.wireProjection,
    })
    .from(workflowDefinition)
    .leftJoin(
      workflowDefinitionVersion,
      and(
        eq(workflowDefinitionVersion.definitionId, workflowDefinition.id),
        eq(
          workflowDefinitionVersion.version,
          workflowDefinition.currentVersion,
        ),
      ),
    )
    .where(eq(workflowDefinition.assetId, input.definitionAssetId))
    .orderBy(desc(workflowDefinition.createdAt));
  return pickLaunchableDefinition(
    rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      status: row.status,
      createdAt: row.createdAt,
      approvedWireHash: row.approvedWireHash ?? null,
      grantSnapshot: row.grantSnapshot ?? null,
      wireProjection: row.wireProjection ?? null,
    })),
    input.tenantId,
  );
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
