ALTER TABLE "workflow_run"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
