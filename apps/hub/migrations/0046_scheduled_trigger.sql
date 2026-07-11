-- Automation triggers (CL-2609): durable per-member schedules that fire a
-- workflow run on a daily UTC-hour cadence. The hub scheduler loads enabled
-- rows each tick and starts a run for any whose target hour has arrived and has
-- not fired today (tracked by last_fired_day_utc, the integer UTC day index).
-- One row per (tenant, owner, kind) so the boot heartbeat seeder is idempotent.

CREATE TABLE IF NOT EXISTS "scheduled_trigger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "owner_member_principal_id" text NOT NULL,
  "workflow_kind" text NOT NULL,
  "hour_utc" integer NOT NULL,
  "cron" text,
  "trigger_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "last_fired_day_utc" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "scheduled_trigger_owner_kind_uniq" UNIQUE ("tenant_id", "owner_member_principal_id", "workflow_kind")
);
