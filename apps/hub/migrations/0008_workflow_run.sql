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
DO $$ BEGIN
 ALTER TABLE "artifact" ADD CONSTRAINT "artifact_session_id_workflow_run_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pain_point" ADD CONSTRAINT "pain_point_session_id_workflow_run_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
