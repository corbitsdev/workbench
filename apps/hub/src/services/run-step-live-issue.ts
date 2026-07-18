import type { DB } from "@intx/db";
import { agentInstance } from "@intx/db/schema";
import { analyticsEvent } from "@workbench/analytics";
import { and, desc, eq, gte, like } from "drizzle-orm";
import { type } from "arktype";
import { escapeLikePattern } from "../lib/like-pattern";

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

// The raw sidecar error text (`message`) is read off the row above for
// internal use only — it never leaves this module. The member-facing shape
// carries just the category the UI maps to a plain-language line, per the
// house rule that raw internal failure text never reaches a member-facing
// surface.
export interface RunStepLiveIssue {
  category: string;
  occurredAt: string;
}

interface StepLiveIssueQuery {
  stepId: string;
  attempt: number;
  since: Date;
}

// `analytics_event` carries no secondary indexes by design (see the schema
// comment in packages/analytics/src/schema.ts) — every read here is an
// intentionally infrequent table scan, damped two ways: batched to one query
// per run (below) rather than one per in-flight step, and memoized for a
// short TTL (see `getRunStepLiveIssues`) so repeated SSE deltas within the
// window reuse the same result instead of re-scanning.
const LIVE_ISSUE_CACHE_TTL_MS = 5_000;
const LIVE_ISSUE_CACHE_MAX_ENTRIES = 200;

interface LiveIssueCacheEntry {
  expiresAt: number;
  value: Map<string, RunStepLiveIssue>;
}

const liveIssueCache = new Map<string, LiveIssueCacheEntry>();

function liveIssueCacheKey(
  runId: string,
  steps: readonly StepLiveIssueQuery[],
): string {
  const signature = [...steps]
    .sort((a, b) => a.stepId.localeCompare(b.stepId))
    .map((s) => `${s.stepId}:${s.attempt}`)
    .join(",");
  return `${runId}|${signature}`;
}

function pruneLiveIssueCache(now: number): void {
  for (const [key, entry] of liveIssueCache) {
    if (entry.expiresAt <= now) liveIssueCache.delete(key);
  }
}

function rememberLiveIssues(
  key: string,
  value: Map<string, RunStepLiveIssue>,
  now: number,
): void {
  if (liveIssueCache.size >= LIVE_ISSUE_CACHE_MAX_ENTRIES) {
    const oldestKey = liveIssueCache.keys().next().value;
    if (oldestKey !== undefined) liveIssueCache.delete(oldestKey);
  }
  liveIssueCache.set(key, { expiresAt: now + LIVE_ISSUE_CACHE_TTL_MS, value });
}

// Match an instance address back to the step it belongs to. All steps in a
// single call share the same deploymentId (one run), so the address prefix
// query below is scoped to the deployment only; this narrows the remaining
// `ins_<deploymentId>-` suffix to an exact `<stepId>@` match rather than a
// second `like` per step.
function matchStepId(
  address: string,
  addressPrefix: string,
  stepIds: Iterable<string>,
): string | undefined {
  if (!address.startsWith(addressPrefix)) return undefined;
  const rest = address.slice(addressPrefix.length);
  for (const stepId of stepIds) {
    if (rest.startsWith(`${stepId}@`)) return stepId;
  }
  return undefined;
}

async function queryRunStepLiveIssues(args: {
  db: DB["db"];
  tenantId: string;
  deploymentId: string;
  steps: readonly StepLiveIssueQuery[];
}): Promise<Map<string, RunStepLiveIssue>> {
  const addressPrefix = `ins_${args.deploymentId}-`;
  const sinceByStep = new Map(args.steps.map((s) => [s.stepId, s.since]));
  const earliestSince = args.steps.reduce(
    (min, s) => (s.since < min ? s.since : min),
    args.steps[0]!.since,
  );

  // One query for every in-flight step in the run, rather than one per step
  // (CL-3887 review) — `analytics_event` has no secondary index, so a
  // per-step read on every SSE emitState delta multiplies an unindexed scan
  // by the in-flight step count on every tick.
  const rows = await args.db
    .select({
      address: agentInstance.address,
      metadata: analyticsEvent.metadata,
      occurredAt: analyticsEvent.occurredAt,
    })
    .from(analyticsEvent)
    .innerJoin(agentInstance, eq(agentInstance.id, analyticsEvent.instanceId))
    .where(
      and(
        eq(analyticsEvent.tenantId, args.tenantId),
        eq(analyticsEvent.eventType, "inference_error"),
        gte(analyticsEvent.occurredAt, earliestSince),
        like(agentInstance.address, `${escapeLikePattern(addressPrefix)}%`),
      ),
    )
    .orderBy(desc(analyticsEvent.occurredAt));

  const result = new Map<string, RunStepLiveIssue>();
  for (const row of rows) {
    if (result.size === sinceByStep.size) break;
    const stepId = matchStepId(row.address, addressPrefix, sinceByStep.keys());
    if (stepId === undefined || result.has(stepId)) continue;
    const since = sinceByStep.get(stepId);
    if (since === undefined || row.occurredAt < since) continue;
    const metadata = RunStepLiveIssueMetadataSchema(row.metadata);
    if (metadata instanceof type.errors) continue;
    result.set(stepId, {
      category: metadata.category,
      occurredAt: row.occurredAt.toISOString(),
    });
  }
  return result;
}

// Batched, memoized read of the latest live inference issue for every
// in-flight step of a single run. Only surfaced for a step still in-flight,
// and only when the issue occurred at or after the step's own start — an
// inference error from a PRIOR invocation of this step id (a much earlier
// attempt of a long-lived step) must not read as live. A bumped `attempt`
// changes the cache key, so a retry never serves a stale cached issue from
// the previous attempt.
export async function getRunStepLiveIssues(args: {
  db: DB["db"];
  tenantId: string;
  deploymentId: string;
  runId: string;
  steps: readonly StepLiveIssueQuery[];
}): Promise<Map<string, RunStepLiveIssue>> {
  if (args.steps.length === 0) return new Map();

  const now = Date.now();
  pruneLiveIssueCache(now);
  const cacheKey = liveIssueCacheKey(args.runId, args.steps);
  const cached = liveIssueCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > now) return cached.value;

  const result = await queryRunStepLiveIssues(args);
  rememberLiveIssues(cacheKey, result, now);
  return result;
}
