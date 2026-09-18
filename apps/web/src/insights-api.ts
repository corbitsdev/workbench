// This app's fetch/query plumbing over the native tenant-scoped
// `GET /workflows/runs` top-level listing →
// Paginated<WorkflowRunResponse>. deleted `@corbits/run-scope`'s
// `/top-level-runs?feed=fires`, which used to attribute each fire to its
// routine server-side; deleted `packages/insights` itself — the
// hub mounts nothing Workbench-specific any more. The four stock
// observability routes (`vendor/intx/hub-api/src/routes/observability.ts`)
// are unimplemented stubs (each returns 501), so usage/cost/activity,
// tool-call, latency, run-trace, and cross-workbench scope all lost their
// only data source and are dropped rather than faked — see the PR
// description for the full accounting.

import { type } from "arktype";
import { WorkflowRunResponse, paginatedSchema } from "@intx/types";

export const ListingTurnSchema = type({
  status: "string",
  "endedAt?": "string | null",
});

/**
 * `WorkflowRunResponse` plus the two routine-attribution fields the deleted
 * `feed=fires` mode of `/top-level-runs` used to report: the
 * routine that fired this run, when it has one. The native
 * `GET /workflows/runs` listing has no routine attribution, so both are
 * absent there — callers fall back to `definitionId`/`definitionName`
 * (`groupRunsByDefinition`, `runDisplayName` in `./insights-stats.ts`)
 * instead of inventing a routine. Both stay `null` (when present) for a
 * run with no routine/task parent — a directly launched workflow.
 * `turns` / `hasInFlightTurn` are this build's listing of in-flight
 * inference turns for the run (not Interchange fields) so a live
 * tool-loop can stay running past the abandoned-fire window. Omitting
 * them is not "no in-flight turn".
 */
export const InsightsRunSchema = WorkflowRunResponse.and(
  type({
    "routineId?": "string | null",
    "routineName?": "string | null",
    "hasInFlightTurn?": "boolean",
    "turns?": ListingTurnSchema.array(),
  }),
);
export type InsightsRun = typeof InsightsRunSchema.infer;

/** Native `GET /workflows/runs` envelope. */
export const TopLevelRunsSchema = paginatedSchema(InsightsRunSchema);

// The REST pagination ceiling (see `vendor/intx/hub-api/src/pagination.ts`) —
// same limit `agents-api.ts`'s `listTopLevelRuns` uses for this route.
const TOP_LEVEL_RUNS_LIMIT = 100;

/**
 * Insights' run feed (; repointed to native in): the
 * tenant's top-level runs from `GET /workflows/runs` — the native
 * listing's own predicate (`address IS NOT NULL AND anchorRunId = id`,
 * see `vendor/intx/hub-api/src/routes/runs.ts`) already excludes every
 * non-top-level run (workbench host, invited agent), so this page never
 * derives that exclusion itself. Four differences from the deleted
 * `feed=fires` feed, all recorded as accepted loss in: a
 * routine's fire (not a top-level run) is no longer included, so
 * Insights no longer sees routine executions; there is no routine
 * attribution, so history groups by definition; the resident,
 * never-triggered deployment placeholder (`status: "deployed"`) is now
 * included — `computeInsightsStats` counts it as deployed rather than
 * hiding it; and the feed is single-tenant — the deleted route expanded
 * the requested tenant to its whole descendant subtree via
 * `getDescendantTenants` (the same rollup `resolveScope` used to give
 * `/usage`, `/activity`, and `/tools` before deleted them), while
 * the native listing filters `tenantId = requested tenant` only, so a
 * workspace parent's runs feed no longer rolls up its child workbenches
 * and now sits mismatched against its own usage aggregate (moot now that
 * usage itself is gone). Used in place of the dead `/me/workflows/runs`
 * — its `anchorRunId IS NULL` filter never matched anything, because
 * every addressed run self-anchors at creation, so that feed always came
 * back empty.
 */
export function insightsTopLevelRunsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/workflows/runs?limit=${TOP_LEVEL_RUNS_LIMIT}`;
}

/** One run's event log, from the stock
 * `GET /workflows/runs/:runId/events` route. `body` is left unparsed
 * (`unknown`) since its shape varies by event type — `runFailureMessage`
 * below is the one place that reaches into it. */
export const RunEventSchema = type({
  seq: "number",
  type: "string",
  body: "unknown",
});

export const RunEventsSchema = type({
  runId: "string",
  events: RunEventSchema.array(),
});
export type RunEvent = typeof RunEventSchema.infer;
export type RunEvents = typeof RunEventsSchema.infer;

export function insightsRunEventsPath(tenantId: string, runId: string): string {
  return `/api/tenants/${tenantId}/workflows/runs/${encodeURIComponent(runId)}/events`;
}

/** The failed run's own explanation: the last `RunFailed`/`StepFailed`
 * event's `error.message`, read defensively since `body` is unparsed. Null
 * when no failure event carries a message — the caller falls back to a
 * generic notice rather than showing nothing. */
export function runFailureMessage(events: readonly RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type !== "RunFailed" && event.type !== "StepFailed") continue;
    const body = event.body;
    if (typeof body !== "object" || body === null) continue;
    const error = (body as Record<string, unknown>)["error"];
    if (typeof error !== "object" || error === null) continue;
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  return null;
}
