-- Create approval table backing the approval schema and the ask_principal HITL
-- flow (CL-1302). Added to schema.ts in PR #64 without a migration, so deployed
-- environments never had the table.
CREATE TABLE IF NOT EXISTS "approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"context" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
