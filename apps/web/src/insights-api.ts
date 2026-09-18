// Fetch/query plumbing over the native tenant-scoped `GET /workflows/runs`
// listing. See docs/insights-native-runs.md for the cutover from the
// deleted run-scope/insights packages and what was dropped.

import { type } from "arktype";
import { WorkflowRunResponse, paginatedSchema } from "@intx/types";

export const ListingTurnSchema = type({
  status: "string",
  "endedAt?": "string | null",
});

// `routineId`/`routineName` and `turns`/`hasInFlightTurn` are this app's
// own additions, absent on the native feed — see docs/insights-native-runs.md.
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

// The REST pagination ceiling — same limit `agents-api.ts`'s
// `listTopLevelRuns` uses for this route.
const TOP_LEVEL_RUNS_LIMIT = 100;

// The native listing already excludes every non-top-level run. See
// docs/insights-native-runs.md for the accepted-loss differences.
export function insightsTopLevelRunsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/workflows/runs?limit=${TOP_LEVEL_RUNS_LIMIT}`;
}

// `body` is left unparsed since its shape varies by event type —
// `runFailureMessage` below is the one place that reaches into it.
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

// Null when no failure event carries a message — the caller falls back
// to a generic notice rather than showing nothing.
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
