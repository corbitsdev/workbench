import { type } from "arktype";

// The heartbeat workflow's kind literal. Shared between the hub scheduler
// config (apps/hub/src/config.ts) and the heartbeat workflow package
// (workflows/heartbeat) so the two never drift — the hub does not import
// workflow packages, so this constant lives here instead of being re-exported
// from workflows/heartbeat.
export const HEARTBEAT_WORKFLOW_KIND = "heartbeat";

// Schedule scope (CL-4108 / CL-4111): personal = Just for me; tenant = Everyone.
// Team ≡ Tenant in product language — there is no third "team" scope.
export const ScheduleScopeSchema = type("'personal' | 'tenant'");
export type ScheduleScope = typeof ScheduleScopeSchema.infer;

export const SCHEDULE_SCOPES = [
  "personal",
  "tenant",
] as const satisfies readonly ScheduleScope[];

// Automation triggers that fire a workflow run on a daily cadence.
// The hub scheduler loads enabled rows each tick and starts a run for any whose
// target UTC hour has arrived and has not already fired today. These schemas are
// the API boundary between the hub routes and the web client.

/** One scheduler fire surfaced in the owner's schedule history (CL-3526). */
export const ScheduledTriggerFireSchema = type({
  runId: "string",
  /** ISO-8601 instant the scheduler recorded this fire. */
  firedAt: "string",
  /** Live workflow_run_record status when known; `unknown` when the run row is gone. */
  status: "string",
});
export type ScheduledTriggerFire = typeof ScheduledTriggerFireSchema.infer;

// A schedule as returned to its owner (and, for tenant scope, to tenant members).
export const ScheduledTriggerSchema = type({
  id: "string",
  workflowKind: "string",
  hourUtc: "number.integer",
  enabled: "boolean",
  /** personal = Just for me; tenant = Everyone (CL-4108). */
  scope: ScheduleScopeSchema,
  /**
   * Principal that created the schedule. For personal scope this is the only
   * member who can mutate it; for tenant scope any member may see the row but
   * only the creator mutates it (v1).
   */
  ownerMemberPrincipalId: "string",
  triggerPayload: { "[string]": "unknown" },
  createdAt: "string",
  lastFiredDayUtc: "number.integer | null",
  /** Most recent run id started by the scheduler; null before the first successful start. */
  lastRunId: "string | null",
  /** Newest-first recent fires (bounded server-side). */
  recentFires: ScheduledTriggerFireSchema.array(),
  /** ISO-8601 instant of the next fire when enabled; null when paused. */
  nextFireAt: "string | null",
});
export type ScheduledTrigger = typeof ScheduledTriggerSchema.infer;

// The GET /me/schedules response: one keyset-paginated page of schedules visible
// to the caller (owned personal + tenant-scoped in their tenant), newest first.
export const ScheduledTriggerListResponseSchema = type({
  items: ScheduledTriggerSchema.array(),
  "nextCursor?": "string",
});
export type ScheduledTriggerListResponse =
  typeof ScheduledTriggerListResponseSchema.infer;

// Create body: which workflow, at which UTC hour, with which trigger payload,
// and (CL-4108) which scope — default personal when omitted.
export const CreateScheduledTriggerBodySchema = type({
  kind: "string > 0",
  hourUtc: "0 <= number.integer <= 23",
  "payload?": { "[string]": "unknown" },
  "scope?": ScheduleScopeSchema,
});
export type CreateScheduledTriggerBody =
  typeof CreateScheduledTriggerBodySchema.infer;

// The trigger payload a heartbeat schedule fires with. The seeder validates
// every payload through this before writing, and the workflow reads it as its
// trigger input. `userAddress`/`userRefId` are server-derived identity — never
// accepted from a client. `enabledSources` is re-derived from the member's
// current `briefSource:*` preferences at fire time (see the scheduler wiring),
// not carried in the durably-stored schedule row — so a source toggle takes
// effect on the very next fire, not just future schedules.
export const HeartbeatTriggerPayloadSchema = type({
  reason: "'scheduled-heartbeat'",
  userAddress: "string > 0",
  userRefId: "string > 0",
  "createdAfter?": "string",
  "enabledSources?": "string[]",
});
export type HeartbeatTriggerPayload =
  typeof HeartbeatTriggerPayloadSchema.infer;

/** Payload the hub passes into a heartbeat run after fire-time enrichment. */
export const HeartbeatRunTriggerPayloadSchema = type({
  reason: "'scheduled-heartbeat' | 'manual-brief'",
  userAddress: "string > 0",
  userRefId: "string > 0",
  createdAfter: "string",
  enabledSources: "string[]",
  "userDisplayName?": "string > 0",
});
export type HeartbeatRunTriggerPayload =
  typeof HeartbeatRunTriggerPayloadSchema.infer;

// Update body: toggle enablement, move the fire hour, and/or replace the
// stored intake payload (CL-3861 edit path). At least one field is required;
// an empty patch is a no-op the route rejects. Scope is immutable after create
// (delete + re-attach to change).
export const UpdateScheduledTriggerBodySchema = type({
  "enabled?": "boolean",
  "hourUtc?": "0 <= number.integer <= 23",
  "payload?": { "[string]": "unknown" },
});
export type UpdateScheduledTriggerBody =
  typeof UpdateScheduledTriggerBodySchema.infer;

/**
 * Resolve allowed schedule scopes for a catalog kind (CL-4110).
 * Heartbeat is personal-only (member identity). Other attachable kinds may
 * offer Everyone; non-attachable kinds still report personal-only defaults
 * so the catalog field is always present.
 */
export function scheduleScopesForKind(
  kind: string,
  attachable: boolean,
): { allowedScopes: ScheduleScope[]; defaultScope: ScheduleScope } {
  if (!attachable || kind === HEARTBEAT_WORKFLOW_KIND) {
    return { allowedScopes: ["personal"], defaultScope: "personal" };
  }
  return {
    allowedScopes: ["personal", "tenant"],
    defaultScope: "personal",
  };
}
