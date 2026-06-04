-- Add workbench_user table to track Interchange provisioning state per user.
-- Rows are inserted at signup and updated once provisioning completes.
-- Nulls in personal_tenant_id / workbench_principal_id mean provisioning
-- has not yet run (or failed); the repair path re-runs on next login.
CREATE TABLE IF NOT EXISTS "workbench_user" (
  "user_id" text PRIMARY KEY NOT NULL,
  "personal_tenant_id" text,
  "workbench_principal_id" text,
  "provisioned_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
