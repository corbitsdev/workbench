import { type } from "arktype";

// Automation triggers that fire a workflow run on a daily cadence (CL-2609).
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

// Create body: which workflow, at which UTC hour, with which trigger payload.
export const CreateScheduledTriggerBodySchema = type({
  kind: "string > 0",
  hourUtc: "0 <= number.integer <= 23",
  "payload?": { "[string]": "unknown" },
});
export type CreateScheduledTriggerBody =
  typeof CreateScheduledTriggerBodySchema.infer;

// Update body: toggle enablement and/or move the fire hour. At least one field
// is required; an empty patch is a no-op the route rejects.
export const UpdateScheduledTriggerBodySchema = type({
  "enabled?": "boolean",
  "hourUtc?": "0 <= number.integer <= 23",
});
export type UpdateScheduledTriggerBody =
  typeof UpdateScheduledTriggerBodySchema.infer;
