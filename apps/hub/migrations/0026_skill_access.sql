CREATE TABLE IF NOT EXISTS "skill_access" (
  "asset_id" text PRIMARY KEY,
  "scope" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "owner_principal_id" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
