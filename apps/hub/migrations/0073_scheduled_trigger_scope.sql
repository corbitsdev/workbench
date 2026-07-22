-- CL-4108: schedule scope — personal (Just for me) vs tenant (Everyone).
-- Existing rows backfill to personal. Uniqueness splits by scope so a member
-- can keep a personal schedule for a kind while the tenant holds at most one
-- Everyone schedule for that kind.

ALTER TABLE "scheduled_trigger"
  ADD COLUMN IF NOT EXISTS "scope" text NOT NULL DEFAULT 'personal';

ALTER TABLE "scheduled_trigger"
  DROP CONSTRAINT IF EXISTS "scheduled_trigger_owner_kind_uniq";

ALTER TABLE "scheduled_trigger"
  DROP CONSTRAINT IF EXISTS "scheduled_trigger_scope_check";

ALTER TABLE "scheduled_trigger"
  ADD CONSTRAINT "scheduled_trigger_scope_check"
  CHECK ("scope" IN ('personal', 'tenant'));

CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_trigger_personal_owner_kind_uniq"
  ON "scheduled_trigger" ("tenant_id", "owner_member_principal_id", "workflow_kind")
  WHERE "scope" = 'personal';

CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_trigger_tenant_kind_uniq"
  ON "scheduled_trigger" ("tenant_id", "workflow_kind")
  WHERE "scope" = 'tenant';
