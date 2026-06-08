ALTER TABLE "artifact" ADD COLUMN IF NOT EXISTS "tenant_id" text;
ALTER TABLE "artifact" ADD COLUMN IF NOT EXISTS "principal_id" text;
ALTER TABLE "artifact" ADD COLUMN IF NOT EXISTS "source" jsonb;
