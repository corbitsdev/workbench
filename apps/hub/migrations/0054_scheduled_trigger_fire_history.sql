-- CL-3526: link automation schedules to the workflow runs they start.
-- Workbench-owned hub schema only: extends `scheduled_trigger` (0047) and adds
-- `scheduled_trigger_fire`. References no Interchange-owned table; `run_id` is an
-- opaque id joined to workbench `workflow_run_record` at read time.
-- `last_run_id` is the most recent successful scheduler start; `scheduled_trigger_fire`
-- retains a bounded audit trail for the Settings schedules UI.

ALTER TABLE "scheduled_trigger"
  ADD COLUMN IF NOT EXISTS "last_run_id" text;

CREATE TABLE IF NOT EXISTS "scheduled_trigger_fire" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scheduled_trigger_id" uuid NOT NULL REFERENCES "scheduled_trigger" ("id") ON DELETE CASCADE,
  "tenant_id" text NOT NULL,
  "run_id" text NOT NULL,
  "fired_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "scheduled_trigger_fire_schedule_fired_idx"
  ON "scheduled_trigger_fire" ("scheduled_trigger_id", "fired_at" DESC);