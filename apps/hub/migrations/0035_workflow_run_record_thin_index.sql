-- CL-2669: shrink workflow_run_record to a THIN RUN INDEX. A run's per-step and
-- run state is now read on demand from its native git event log
-- (run-state-from-log.ts); the row keeps only run-level identity, ownership,
-- kind, the coarse run-level status, and run wall-clock timing.
--
-- Add run-level timing, written by the projection bridge from the log's
-- RunStarted / terminal events. Nullable — a run that never started, or a row
-- that predates this migration, simply carries NULL.
ALTER TABLE "workflow_run_record" ADD COLUMN IF NOT EXISTS "started_at" timestamp;
ALTER TABLE "workflow_run_record" ADD COLUMN IF NOT EXISTS "ended_at" timestamp;

-- Drop the former step-level mirror. The event log is the source of truth for
-- step phase, outputs, and errors (irreversible; the values were always
-- re-derivable from the log).
ALTER TABLE "workflow_run_record" DROP COLUMN IF EXISTS "current_step_id";
ALTER TABLE "workflow_run_record" DROP COLUMN IF EXISTS "outputs";
ALTER TABLE "workflow_run_record" DROP COLUMN IF EXISTS "error";
