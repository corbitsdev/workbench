-- Adds an optional assignee to native Workbench tasks so a task owner can
-- hand work to another tenant member. Nullable: an unassigned task keeps
-- today's owner-only behavior. Workbench-owned column holding an interchange
-- principal id by value, same convention as owner_principal_id.

ALTER TABLE "task"
  ADD COLUMN IF NOT EXISTS "assignee_principal_id" text;

CREATE INDEX IF NOT EXISTS "task_tenant_assignee_status_idx"
  ON "task" ("tenant_id", "assignee_principal_id", "status");
