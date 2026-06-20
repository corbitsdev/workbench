ALTER TABLE "workflow_run"
  ADD COLUMN IF NOT EXISTS "deployment_id" text;

CREATE INDEX IF NOT EXISTS "workflow_run_deployment_id_idx"
  ON "workflow_run" ("deployment_id");
