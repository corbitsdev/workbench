-- CL-3932: interchange gained its own "approval" table at pin 5a73d3cc
-- (interchange migration 0038). The workbench's own approval table (the
-- ask_principal / ReviewGate rail, created in 0011_approval.sql) is renamed to
-- "workbench_approval" to avoid the collision. The actual rename / fresh-create
-- happens in the PRE-INTERCHANGE reconcile step in scripts/db-setup.ts
-- (apps/hub/src/db/workbench-approval-reconcile.ts) because it MUST run before
-- interchange's bare CREATE TABLE "approval" and before workbench 0040's
-- approval index. This migration is the canonical, ledgered record of the
-- workbench_approval table (satisfies the "migrations cover the schema" guard);
-- it is idempotent and normally a no-op, since the reconcile step already
-- created or renamed the table by the time custom migrations run.
--
-- Shape MUST match 0011_approval.sql, the workbench_approval schema in
-- apps/hub/src/db/schema.ts, and workbench-approval-reconcile.ts. Do NOT modify
-- 0011 (history is immutable); its CREATE TABLE "approval" now no-ops on fresh
-- DBs because interchange owns "approval".
CREATE TABLE IF NOT EXISTS "workbench_approval" (
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_tenant_principal_created_idx" ON "workbench_approval" ("tenant_id", "principal_id", "created_at" DESC);
