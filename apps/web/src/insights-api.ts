import { type } from "arktype";
import { RunApprovalsResponse, WorkflowRunResponse, paginatedSchema } from "@intx/types";

// `routineId`/`routineName` are optional client-side attribution fields,
// absent on the native `GET /workflows/runs` feed.
export const InsightsRunSchema = WorkflowRunResponse.and(
  type({
    "routineId?": "string | null",
    "routineName?": "string | null",
  }),
);
export type InsightsRun = typeof InsightsRunSchema.infer;

export const TopLevelRunsSchema = paginatedSchema(InsightsRunSchema);

// The REST pagination ceiling — same limit `agents-api.ts`'s
// `listTopLevelRuns` uses for this route.
const TOP_LEVEL_RUNS_LIMIT = 100;

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
    if (!/error|fail/i.test(event.type)) continue;
    const body = event.body;
    if (typeof body !== "object" || body === null) continue;
    const record = body as Record<string, unknown>;
    const error = record["error"];
    if (typeof error === "object" && error !== null) {
      const nestedMessage = (error as Record<string, unknown>)["message"];
      if (typeof nestedMessage === "string" && nestedMessage !== "") return nestedMessage;
    }
    if (typeof record["message"] === "string" && record["message"] !== "") {
      return record["message"];
    }
    if (typeof error === "string" && error !== "") return error;
  }
  return null;
}

export { RunApprovalsResponse };

export function insightsRunApprovalsPath(tenantId: string, runId: string): string {
  return `/api/tenants/${tenantId}/workflows/runs/${encodeURIComponent(runId)}/approvals`;
}
