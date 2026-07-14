-- CL-3509: tag workflow runs with the trigger path that started them, so the
-- stalled-run reconciler can fail scheduler-sourced runs parked past a timeout
-- without touching interactive runs that legitimately wait on a human. Nullable —
-- interactive/manual/webhook starts and every pre-existing row carry NULL; no
-- backfill.
ALTER TABLE "workflow_run_record" ADD COLUMN IF NOT EXISTS "trigger_source" text;
