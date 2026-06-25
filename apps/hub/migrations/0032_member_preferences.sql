-- Server-persisted per-member UI preferences (theme, chat display options, …).
-- One row per (tenant, member principal); `preferences` is an open jsonb map so
-- new preference keys need no further migration.

CREATE TABLE IF NOT EXISTS "member_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "member_principal_id" text NOT NULL,
  "preferences" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "member_preferences_tenant_principal_uniq" UNIQUE ("tenant_id", "member_principal_id")
);
