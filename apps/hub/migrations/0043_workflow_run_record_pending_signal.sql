-- Durable pending gate-signal record (hibernation of parked runs).
-- A 202-accepted signal is persisted on the run record BEFORE the
-- fire-and-forget sidecar dispatch, and cleared by the projection once the
-- run log proves it was received. While set, the awaiting reconciler
-- re-delivers it instead of hibernating the run, so a signal racing a
-- hibernate teardown is never lost. Workbench-owned table — touches NO
-- interchange table.
ALTER TABLE "workflow_run_record"
  ADD COLUMN IF NOT EXISTS "pending_signal" jsonb;
