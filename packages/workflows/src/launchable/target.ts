// The one place a routine's target (a workflow asset id) becomes the
// definition that actually runs. Interchange keys `workflow_definition`
// on `(asset_id, wire_hash)` and has no "newest approved deployment of
// this asset" indirection of its own (docs/workflow-model.md), so this
// module supplies exactly that query — and nothing else: no search by
// name, no fallback to an unfrozen row, no pinning. Every caller (create,
// retarget, launch) resolves through here so a routine can never run a
// definition this rule would not have picked.
//
// Moved from `@corbits/routines` into `@corbits/workflows` (CL-7373 fold
// review): "what is launchable" is definition-domain logic, not a routine
// concern — `@corbits/routines` now imports it from here rather than
// owning a second copy. The pure follow-latest rule lives in
// `./target-rule.ts` (no `drizzle-orm`/`@intx/db`, so it is safe on
// `@corbits/workflows/client`); this file is the DB-touching half.
import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { workflowDefinition, workflowDefinitionVersion } from "@intx/db/schema";

import { pickLaunchableDefinition } from "./target-rule";
import type { LaunchableDefinitionResolution } from "./target-rule";

export * from "./target-rule";

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
