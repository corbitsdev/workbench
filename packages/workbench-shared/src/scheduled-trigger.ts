import { type } from "arktype";

// The heartbeat workflow's kind literal. Shared between the hub scheduler
// config (apps/hub/src/config.ts) and the heartbeat workflow package
// (workflows/heartbeat) so the two never drift — the hub does not import
// workflow packages, so this constant lives here instead of being re-exported
// from workflows/heartbeat.
export const HEARTBEAT_WORKFLOW_KIND = "heartbeat";

// The name stamped on the boot-seeded default heartbeat schedule (CL-4268).
// The seeder's idempotency check matches on (tenant, owner, kind, scope,
// name) so a member who later creates a SECOND, differently-named heartbeat
// schedule does not stop the seeder from (re-)ensuring their default one —
// and so the seeder never "adopts" a member's custom-named heartbeat
// schedule as if it were the boot-seeded default.
export const DEFAULT_HEARTBEAT_SCHEDULE_NAME = "Morning brief";

// Schedule scope (CL-4108 / CL-4111): personal = Just for me; tenant = Everyone.
// Team ≡ Tenant in product language — there is no third "team" scope.
export const ScheduleScopeSchema = type("'personal' | 'tenant'");
export type ScheduleScope = typeof ScheduleScopeSchema.infer;

export const SCHEDULE_SCOPES = [
  "personal",
  "tenant",
] as const satisfies readonly ScheduleScope[];

// Routine triggers that fire a workflow run on a recurring cadence. A
// recurrence is `intervalMinutes` (how often, minute granularity) plus
// `anchorMinuteUtc` (minute-of-UTC-day phase, 0-1439) that fixes the wall-clock
// alignment of the cadence. The hub scheduler evaluates a durable
// `lastFiredWindowIndex` = floor((nowMinuteUtc - anchorMinuteUtc) / intervalMinutes)
// each tick and fires whenever the window index advances past the last one it
// fired in — this subsumes the old daily-at-hour model (intervalMinutes=1440,
// anchorMinuteUtc=hourUtc*60) and adds genuine sub-daily cadences (e.g. every 5
// minutes). These schemas are the API boundary between the hub routes and the
// web client.
export const ScheduleRecurrenceSchema = type({
  intervalMinutes: "1 <= number.integer <= 10080",
  anchorMinuteUtc: "0 <= number.integer < 1440",
});
export type ScheduleRecurrence = typeof ScheduleRecurrenceSchema.infer;

// Minutes in a day — the interval a daily-at-hour recurrence recurs on.
export const DAILY_INTERVAL_MINUTES = 1440;

/**
 * Recurrence constraint per workflow kind. Heartbeat's fire-time enrichment
 * (apps/hub/src/lib/heartbeat-trigger-payload.ts, wired in
 * apps/hub/src/index.ts) reads `lastFiredWindowIndex` as a UTC-DAY index and
 * multiplies it by milliseconds-per-day to compute `createdAfter` — that
 * arithmetic is only correct when heartbeat's recurrence is daily
 * (`intervalMinutes=1440`). Before recurrence existed this was structurally
 * guaranteed (heartbeat only ever had `hourUtc`); now that any routine-eligible
 * kind, heartbeat included, can be created/updated with an arbitrary
 * recurrence, the create/update routes MUST reject a non-daily interval for
 * heartbeat — otherwise a member setting their morning brief to hourly
 * silently sends `createdAfter` thousands of days in the future and the brief
 * stops surfacing anything, forever, with no error.
 */
export function isRecurrenceAllowedForKind(
  kind: string,
  recurrence: ScheduleRecurrence,
): boolean {
  if (kind === HEARTBEAT_WORKFLOW_KIND) {
    return recurrence.intervalMinutes === DAILY_INTERVAL_MINUTES;
  }
  return true;
}

/** One scheduler fire surfaced in the owner's schedule history (CL-3526). */
export const ScheduledTriggerFireSchema = type({
  runId: "string",
  /** ISO-8601 instant the scheduler recorded this fire. */
  firedAt: "string",
  /** Live workflow_run_record status when known; `unknown` when the run row is gone. */
  status: "string",
});
export type ScheduledTriggerFire = typeof ScheduledTriggerFireSchema.infer;

// Max length for a caller-supplied schedule name (CL-4268). Generous enough
// for a descriptive label, bounded so the schedule list stays scannable.
// Kept in sync by hand with the literal `100` in CreateScheduledTriggerBodySchema
// / UpdateScheduledTriggerBodySchema below — arktype's string-length range
// syntax only accepts a literal bound, not a referenced constant.
export const SCHEDULE_NAME_MAX_LENGTH = 100;

/**
 * The default schedule name when the caller doesn't supply one (CL-4268):
 * the workflow kind itself, numbered when it collides with an existing
 * schedule of the same kind in the same scope so several schedules of one
 * workflow stay distinguishable at a glance (e.g. "heartbeat", "heartbeat 2").
 */
export function defaultScheduleName(
  kind: string,
  existingCountForKind: number,
): string {
  return existingCountForKind === 0
    ? kind
    : `${kind} ${existingCountForKind + 1}`;
}

// A schedule as returned to its owner (and, for tenant scope, to tenant members).
export const ScheduledTriggerSchema = type({
  id: "string",
  workflowKind: "string",
  /**
   * User-facing label distinguishing this schedule from any other schedule of
   * the same workflow kind (CL-4268) — several schedules of one workflow are
   * now allowed (e.g. a routine every morning for you and weekly for the
   * workspace). Defaults to the workflow kind when not supplied at create.
   */
  name: "string > 0",
  recurrence: ScheduleRecurrenceSchema,
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
  /** Most recent run id started by the scheduler; null before the first successful start. */
  lastRunId: "string | null",
  /** Newest-first recent fires (bounded server-side); the head entry is "last fired". */
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

// Create body: which workflow, at which recurrence, with which trigger
// payload, and (CL-4108) which scope — default personal when omitted.
export const CreateScheduledTriggerBodySchema = type({
  kind: "string > 0",
  recurrence: ScheduleRecurrenceSchema,
  "payload?": { "[string]": "unknown" },
  "scope?": ScheduleScopeSchema,
  /** Omit to default to the workflow kind (CL-4268). */
  "name?": "0 < string <= 100",
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

// Update body: toggle enablement, move the recurrence, and/or replace the
// stored intake payload (CL-3861 edit path). At least one field is required;
// an empty patch is a no-op the route rejects. Scope is immutable after create
// (delete + re-attach to change).
export const UpdateScheduledTriggerBodySchema = type({
  "enabled?": "boolean",
  "recurrence?": ScheduleRecurrenceSchema,
  "payload?": { "[string]": "unknown" },
  "name?": "0 < string <= 100",
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
