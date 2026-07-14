-- CL-3627: moves the Granola call pipeline's LLM inference off the 60s
-- intake tick. The workspace poller now only lists notes and enqueues a job
-- per new note (cheap, no transcript fetch, no LLM turn); a separate off-tick
-- runner drains this table, doing the transcript fetch + reasoning turn +
-- artifact persistence with durable retry/backoff. Workbench-owned hub schema
-- only: references no Interchange-owned table.

CREATE TABLE IF NOT EXISTS "granola_call_job" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "note_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "granola_call_job_tenant_note_uniq"
  ON "granola_call_job" ("tenant_id", "note_id");

CREATE INDEX IF NOT EXISTS "granola_call_job_status_next_attempt_idx"
  ON "granola_call_job" ("status", "next_attempt_at");
