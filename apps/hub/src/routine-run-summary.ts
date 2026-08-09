// Enriches a routine run's bare id with the run's own status/timing off
// `workflow_run` — the same row `launchFoldedRun` (via `@corbits/folded-runs`)
// writes at launch and the platform's own event pipeline settles into a
// terminal status. Optional per `@corbits/routines`' `RunSummaryResolver`
// contract: a host that skips this still gets bare run ids and timestamps
// back from `GET /routines/:id/runs`.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { workflowRun } from "@intx/db/schema";
import type { RunSummaryResolver } from "@corbits/routines";

export function createHubRunSummaryResolver(db: DB["db"]): RunSummaryResolver {
  return {
    async resolveRunSummary(tenantId, runId) {
      const row = await db.query.workflowRun.findFirst({
        where: and(
          eq(workflowRun.id, runId),
          eq(workflowRun.tenantId, tenantId),
        ),
      });
      if (row === undefined) return undefined;
      return {
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
      };
    },
  };
}
