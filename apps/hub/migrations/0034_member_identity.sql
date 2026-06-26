-- Per-member, per-tool account identity (CL-2420). One row per account, so a
-- member can hold several accounts of the same provider (e.g. two Linear
-- workspaces). `value` is the identifier scoped into "my X" queries; `label`,
-- `is_primary`, and the open `metadata` map carry the rest. One primary per
-- provider is enforced by the application, not a constraint.

CREATE TABLE IF NOT EXISTS "member_identity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "member_principal_id" text NOT NULL,
  "provider" text NOT NULL,
  "value" text NOT NULL,
  "label" text,
  "is_primary" boolean NOT NULL DEFAULT false,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "member_identity_account_uniq" UNIQUE ("tenant_id", "member_principal_id", "provider", "value")
);
