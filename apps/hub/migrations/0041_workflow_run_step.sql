-- CL-2727: per-step run state projection table. Workbench-owned. Mirrors the
-- authoritative per-step state the native @intx/workflow state machine computes
-- when it folds a run's event log, so the hub can serve per-step state and
-- aggregate stats without re-reading the git log on every request. Distinct from
-- workflow_run (deployment index) and workflow_run_record (run index); touches
-- NO interchange-owned table.
CREATE TABLE IF NOT EXISTS "workflow_run_step" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" text NOT NULL,
  "step_id" text NOT NULL,
  "phase" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_run_step_run_step_uniq" UNIQUE ("run_id", "step_id")
);

-- The stats aggregate and the solo-run read both filter by run_id.
CREATE INDEX IF NOT EXISTS "workflow_run_step_run_id_idx" ON "workflow_run_step" ("run_id");

-- CL-2727 run liveness sweep support. The sweep scans workflow_run_record for
-- stale `running` candidates (status = 'running' AND deleted_at IS NULL AND
-- updated_at < cutoff) on an interval. A partial index on the only status it
-- ever scans keeps that scan cheap as the record table grows with terminal runs
-- (the overwhelming majority), without indexing every other status. This is a
-- workbench-owned table (workflow_run_record) — touches NO interchange table.
--
-- NOTE: the sweep's terminal write (failRunIfStillRunning) is BEST-EFFORT — the
-- log remains the source of truth. applyRunProjection overwrites the run's
-- status unconditionally on the next pack, which is the intentional self-heal
-- path: if a pack lands after a sweep-fail, the run correctly returns to its
-- real state.
CREATE INDEX IF NOT EXISTS "workflow_run_record_running_sweep_idx"
  ON "workflow_run_record" ("updated_at")
  WHERE "status" = 'running' AND "deleted_at" IS NULL;
