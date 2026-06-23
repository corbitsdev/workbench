-- CL-2240 thin-executor run state. Execution of a deployed workflow definition
-- is held entirely in this row: `outputs` is a stepId->output map, gates park
-- the run at status='awaiting' on `current_step_id`. Distinct from the
-- workflow_run deployment-index table (the native-deploy path still owns that).
CREATE TABLE IF NOT EXISTS "workflow_run_record" (
  "id" text PRIMARY KEY NOT NULL,
  "deployment_id" text,
  "kind" text NOT NULL,
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "current_step_id" text,
  "input" jsonb,
  "outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);

CREATE INDEX IF NOT EXISTS "workflow_run_record_tenant_kind_idx"
  ON "workflow_run_record" ("tenant_id", "kind");
