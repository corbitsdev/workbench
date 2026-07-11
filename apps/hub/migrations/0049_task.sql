-- Native Workbench tasks: a first-class task object with a state
-- machine and downstream mirrors. Both tables are workbench-owned; they hold
-- interchange principal/tenant ids by value only and reference NO
-- interchange-owned table. `task_external_ref` carries one row per
-- (task, adapter) so a concurrent create fails the unique constraint loudly
-- instead of double-pushing, and the reconciler scans `sync_state = 'pending'`.

CREATE TABLE IF NOT EXISTS "task" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "owner_principal_id" text NOT NULL,
  "created_by_principal_id" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "status" text NOT NULL DEFAULT 'open',
  "source" text NOT NULL,
  "source_ref" text,
  "due" timestamp,
  "links" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_tenant_owner_status_idx"
  ON "task" ("tenant_id", "owner_principal_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_external_ref" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "task" ("id") ON DELETE CASCADE,
  "adapter_id" text NOT NULL,
  "external_id" text,
  "external_url" text,
  "sync_state" text NOT NULL DEFAULT 'pending',
  "actor_principal_id" text NOT NULL,
  "last_synced_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "task_external_ref_task_id_adapter_id_uniq" UNIQUE ("task_id", "adapter_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_external_ref_sync_state_idx"
  ON "task_external_ref" ("sync_state");
