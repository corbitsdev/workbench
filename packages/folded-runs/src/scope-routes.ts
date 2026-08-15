// The workbench-owned answer to "which of this tenant's workflow runs
// are genuine top-level deployments, not folded-run plumbing?" — the
// question `packages/chat-ui/src/folded-run-ids.ts` used to answer by
// deriving an exclusion set from a tenant's *channels*, which silently
// missed every task-style folded run (a task creates no channel at
// all). This route answers it server-side instead, straight off
// `workflow_run` plus this package's own `folded_run` marker table (see
// `./schema.ts`), so every folded run — channel host, invited agent, or
// task — is excluded uniformly with no per-consumer opt-in.
//
// The listing predicate mirrors vendor's own "top-level run" predicate
// (`isNotNull(workflowRun.address)`, `anchorRunId === id`) — see
// `vendor/intx/hub-api/src/routes/runs.ts`'s `GET /workflows/runs` and
// `vendor/intx/hub-sessions/src/hub-session-lookups.ts`'s
// `isTopLevelRun`, this route's reference implementation — with one
// addition vendor cannot express: a `NOT EXISTS` against `folded_run`,
// dropping every self-anchored run this package's own `launchFoldedRun`
// ever minted.
import { and, desc, eq, isNotNull, notExists } from "drizzle-orm";
import { Hono } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { DB } from "@intx/db";
import { workflowDefinition, workflowRun } from "@intx/db/schema";
import type { WorkflowRunStatus } from "@intx/types";

import { foldedRun } from "./schema";

export type CreateTopLevelRunRoutesDeps = {
  db: DB["db"];
  requireGrant: RequireGrant;
};

// Mirrors `vendor/intx/hub-api/src/routes/run-view.ts`'s
// `mapRunStatusToViewStatus` (not published from `@intx/hub-api`, so
// this is the small, stable slice of it this route's wire shape
// needs) — a run's raw `workflow_run.status` mapped onto the same
// `WorkflowRunResponse` status vocabulary every other run-listing
// surface already speaks.
function toViewStatus(status: string): WorkflowRunStatus {
  switch (status) {
    case "deployed":
      return "deployed";
    case "running":
      return "running";
    case "completed":
    case "cancelled":
      return "stopped";
    case "failed":
      return "error";
    default:
      throw new Error(`unmapped workflow_run status "${status}"`);
  }
}

function toTimestamp(date: Date): string {
  return date.toISOString();
}

/**
 * The tenant's genuine top-level deployment runs, most recent first,
 * with every folded run excluded — the query `createTopLevelRunRoutes`
 * serves. Exported separately from the route so a non-HTTP caller (a
 * future scoped listing elsewhere in the hub) can reuse the same
 * predicate without going through Hono.
 */
export async function listTopLevelRuns(
  db: DB["db"],
  tenantId: string,
  limit = 100,
) {
  const rows = await db
    .select({
      id: workflowRun.id,
      definitionId: workflowRun.definitionId,
      definitionName: workflowDefinition.name,
      tenantId: workflowRun.tenantId,
      address: workflowRun.address,
      status: workflowRun.status,
      publicKey: workflowRun.publicKey,
      kernelId: workflowRun.kernelId,
      sidecarId: workflowRun.sidecarId,
      createdAt: workflowRun.createdAt,
      endedAt: workflowRun.endedAt,
    })
    .from(workflowRun)
    .innerJoin(
      workflowDefinition,
      eq(workflowRun.definitionId, workflowDefinition.id),
    )
    .where(
      and(
        eq(workflowRun.tenantId, tenantId),
        isNotNull(workflowRun.address),
        eq(workflowRun.anchorRunId, workflowRun.id),
        notExists(
          db.select().from(foldedRun).where(eq(foldedRun.id, workflowRun.id)),
        ),
      ),
    )
    .orderBy(desc(workflowRun.createdAt), desc(workflowRun.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    definitionId: row.definitionId,
    definitionName: row.definitionName,
    tenantId: row.tenantId,
    // Guarded by `isNotNull(workflowRun.address)` above.
    address: row.address as string,
    status: toViewStatus(row.status),
    publicKey: row.publicKey,
    kernelId: row.kernelId,
    sidecarId: row.sidecarId,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.endedAt ?? row.createdAt),
    endedAt: row.endedAt ? toTimestamp(row.endedAt) : null,
  }));
}

/**
 * Mounted at `${TENANT_PREFIX}/top-level-runs` in the hub composition
 * root, beside every other package-owned tenant route. `GET /` is the
 * one route: a paginated-shaped (but not yet cursor-paginated — see
 * the "known limit" note on every caller of this route) list of the
 * tenant's genuine top-level runs.
 */
export function createTopLevelRunRoutes(
  deps: CreateTopLevelRunRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("workflow-run:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const rawLimit = Number(c.req.query("limit"));
    const limit =
      Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
    const data = await listTopLevelRuns(deps.db, tenant.id, limit);
    return c.json({ data, nextCursor: null });
  });

  return app;
}
