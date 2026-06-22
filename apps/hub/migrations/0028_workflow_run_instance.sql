-- CL-2233: user-owned workflow run instances.
-- `workflow_run` is the shared operator DEPLOYMENT (one per kind/tenant);
-- many `workflow_run_instance` rows point at one deployment. `run_id` is the
-- @intx-reactor-minted workflow runId, reconciled lazily from the run-event
-- log via `correlation_message_id`, so it is nullable until reconciled.
CREATE TABLE IF NOT EXISTS "workflow_run_instance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" text,
  "correlation_message_id" text NOT NULL,
  "deployment_id" text NOT NULL,
  "kind" text NOT NULL,
  "tenant_id" text NOT NULL,
  "member_principal_id" text NOT NULL,
  "status" text NOT NULL,
  "input" jsonb,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_run_instance_run_id_idx"
  ON "workflow_run_instance" ("run_id");

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_run_instance_correlation_message_id_idx"
  ON "workflow_run_instance" ("correlation_message_id");

CREATE INDEX IF NOT EXISTS "workflow_run_instance_member_idx"
  ON "workflow_run_instance" ("member_principal_id", "tenant_id");

CREATE INDEX IF NOT EXISTS "workflow_run_instance_deployment_idx"
  ON "workflow_run_instance" ("deployment_id");
