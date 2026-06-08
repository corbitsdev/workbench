-- Create workbench_workflows table backing the enabledWorkflow schema.
-- Introduced with the workflow catalog/install model (PR #99) but shipped
-- without a migration, so deployed environments lacked the table and every
-- GET /api/v1/workflows/enabled query failed with "relation does not exist".
-- Tracks which workflow kinds a tenant has opted into; unique (tenant_id, kind)
-- keeps upserts idempotent.
CREATE TABLE IF NOT EXISTS "workbench_workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"enabled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workbench_workflows" ADD CONSTRAINT "workbench_workflows_tenant_kind_uniq" UNIQUE ("tenant_id", "kind");
EXCEPTION
 WHEN duplicate_table THEN null;
 WHEN duplicate_object THEN null;
END $$;
