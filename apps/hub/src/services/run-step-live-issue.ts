import type { DB } from "@intx/db";
import { agentInstance } from "@intx/db/schema";
import { analyticsEvent } from "@workbench/analytics";
import { and, desc, eq, gte, like } from "drizzle-orm";
import { type } from "arktype";

// A running step gives no signal while it waits on its provider — a raced
// provider hung on the 120s inactivity timeout reads identically to a dead
// run on the run page (CL-3887). The sidecar already reports each
// `inference.error` (timeout, rate limit, credential failure, ...) through
// the existing `agent.event` -> analytics pipeline (packages/analytics); this
// reads the latest one for a step's own instance address so the run page can
// say "provider timed out, retrying" instead of staying silent. No new event
// plumbing — this is a read over data already persisted for cost attribution
// (see `getWorkflowRunStepTokenTotals`, which resolves the same
// `ins_<deploymentId>-<stepId>@` address family).
export const RunStepLiveIssueMetadataSchema = type({
  category: "string",
  message: "string",
});

export interface RunStepLiveIssue {
  category: string;
  message: string;
  occurredAt: string;
}

// Only surfaced for a step still in-flight, and only when the issue occurred
// at or after the step's own start — an inference error from a PRIOR
// invocation of this step id (a much earlier run reusing the same deployment
// slot is impossible per-run, but a much earlier attempt of a long-lived
// step is not) must not read as live. Callers pass the step's `startedAt`.
export async function getRunStepLiveIssue(args: {
  db: DB["db"];
  tenantId: string;
  deploymentId: string;
  stepId: string;
  since: Date;
}): Promise<RunStepLiveIssue | null> {
  const addressPrefix = `ins_${args.deploymentId}-${args.stepId}@`;
  const rows = await args.db
    .select({
      metadata: analyticsEvent.metadata,
      occurredAt: analyticsEvent.occurredAt,
    })
    .from(analyticsEvent)
    .innerJoin(agentInstance, eq(agentInstance.id, analyticsEvent.instanceId))
    .where(
      and(
        eq(analyticsEvent.tenantId, args.tenantId),
        eq(analyticsEvent.eventType, "inference_error"),
        gte(analyticsEvent.occurredAt, args.since),
        like(agentInstance.address, `${addressPrefix}%`),
      ),
    )
    .orderBy(desc(analyticsEvent.occurredAt))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  const metadata = RunStepLiveIssueMetadataSchema(row.metadata);
  if (metadata instanceof type.errors) return null;
  return {
    category: metadata.category,
    message: metadata.message,
    occurredAt: row.occurredAt.toISOString(),
  };
}
