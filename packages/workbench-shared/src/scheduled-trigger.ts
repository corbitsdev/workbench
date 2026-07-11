import { type } from "arktype";

// Automation triggers that fire a workflow run on a daily cadence.
// The hub scheduler loads enabled rows each tick and starts a run for any whose
// target UTC hour has arrived and has not already fired today. These schemas are
// the API boundary between the hub routes and the web client.

// A schedule as returned to its owner.
export const ScheduledTriggerSchema = type({
  id: "string",
  workflowKind: "string",
  hourUtc: "number.integer",
  enabled: "boolean",
  triggerPayload: { "[string]": "unknown" },
  createdAt: "string",
});
export type ScheduledTrigger = typeof ScheduledTriggerSchema.infer;

// The GET /me/schedules response: one keyset-paginated page of the caller's
// schedules, newest first, with an opaque cursor for the next page when one
// exists.
export const ScheduledTriggerListResponseSchema = type({
  items: ScheduledTriggerSchema.array(),
  "nextCursor?": "string",
});
export type ScheduledTriggerListResponse =
  typeof ScheduledTriggerListResponseSchema.infer;

// Create body: which workflow, at which UTC hour, with which trigger payload.
export const CreateScheduledTriggerBodySchema = type({
  kind: "string > 0",
  hourUtc: "0 <= number.integer <= 23",
  "payload?": { "[string]": "unknown" },
});
export type CreateScheduledTriggerBody =
  typeof CreateScheduledTriggerBodySchema.infer;

// The trigger payload a heartbeat schedule fires with. The seeder validates
// every payload through this before writing, and the workflow reads it as its
// trigger input. `userAddress`/`userRefId` are server-derived identity — never
// accepted from a client.
export const HeartbeatTriggerPayloadSchema = type({
  reason: "'scheduled-heartbeat'",
  userAddress: "string > 0",
  userRefId: "string > 0",
  "createdAfter?": "string",
});
export type HeartbeatTriggerPayload =
  typeof HeartbeatTriggerPayloadSchema.infer;

// Update body: toggle enablement and/or move the fire hour. At least one field
// is required; an empty patch is a no-op the route rejects.
export const UpdateScheduledTriggerBodySchema = type({
  "enabled?": "boolean",
  "hourUtc?": "0 <= number.integer <= 23",
});
export type UpdateScheduledTriggerBody =
  typeof UpdateScheduledTriggerBodySchema.infer;
