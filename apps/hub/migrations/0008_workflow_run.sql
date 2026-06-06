-- Create generic workflow_run table to replace workflow-specific tables.
-- This unifies workbench_session and collateral_generation_workflow patterns.
CREATE TABLE IF NOT EXISTS "workflow_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Drop old FKs to workbench_session; new FKs will be added in 0009 after data migration
DO $$ BEGIN
 ALTER TABLE "artifact" DROP CONSTRAINT IF EXISTS "artifact_session_id_workbench_session_id_fk";
EXCEPTION
 WHEN undefined_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pain_point" DROP CONSTRAINT IF EXISTS "pain_point_session_id_workbench_session_id_fk";
EXCEPTION
 WHEN undefined_object THEN null;
END $$;
