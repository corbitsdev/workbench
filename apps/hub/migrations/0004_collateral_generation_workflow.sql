CREATE TABLE IF NOT EXISTS "collateral_generation_workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input_artifact_ids" jsonb DEFAULT '[]' NOT NULL,
	"output_types" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE artifact ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE artifact ADD COLUMN IF NOT EXISTS workflow_id uuid REFERENCES collateral_generation_workflow(id) ON DELETE SET NULL;
