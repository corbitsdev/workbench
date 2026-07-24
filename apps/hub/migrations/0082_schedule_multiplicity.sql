-- Allow several schedules of the same workflow kind per owner (and per
-- tenant, for Everyone schedules). The old model keyed uniqueness to
-- (tenant, owner, kind) / (tenant, kind), so a member could only ever hold
-- one schedule per workflow -- too narrow for cadences like "daily for me,
-- weekly for the workspace" on the same routine.
--
-- Drop both partial unique indexes and give every schedule a user-facing
-- `name` so several schedules of the same kind stay distinguishable in a
-- list, in run history, and anywhere a run is attributed back to what
-- scheduled it. Existing rows backfill `name` to their workflow_kind --
-- the same string the UI already showed as the schedule's label before this
-- migration, so nothing regresses for a member with a single schedule.

DROP INDEX IF EXISTS "scheduled_trigger_personal_owner_kind_uniq";
DROP INDEX IF EXISTS "scheduled_trigger_tenant_kind_uniq";

ALTER TABLE "scheduled_trigger"
  ADD COLUMN "name" text;

UPDATE "scheduled_trigger"
SET "name" = "workflow_kind"
WHERE "name" IS NULL;

ALTER TABLE "scheduled_trigger"
  ALTER COLUMN "name" SET NOT NULL,
  ADD CONSTRAINT "scheduled_trigger_name_check" CHECK (length("name") > 0);

-- Uniqueness moves from "one schedule per (tenant, owner, kind)" to "one
-- schedule per (tenant, owner, kind, name)" -- several differently-named
-- schedules of the same kind are now allowed, but the boot-time heartbeat
-- seeder still needs a race-safe target for its idempotent ensure-schedule
-- upsert (see ensureOwnerSchedule in apps/hub/src/lib/scheduled-triggers.ts).
CREATE UNIQUE INDEX "scheduled_trigger_personal_owner_kind_name_uniq"
  ON "scheduled_trigger" ("tenant_id", "owner_member_principal_id", "workflow_kind", "name")
  WHERE "scope" = 'personal';

CREATE UNIQUE INDEX "scheduled_trigger_tenant_kind_name_uniq"
  ON "scheduled_trigger" ("tenant_id", "workflow_kind", "name")
  WHERE "scope" = 'tenant';
