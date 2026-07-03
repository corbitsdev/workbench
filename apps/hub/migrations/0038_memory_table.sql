-- CL-2668: durable agent memory moves out of the artifact table into its own
-- table. No versioning, one row per (tenant, owner) via a plain unique index.

CREATE TABLE IF NOT EXISTS "memory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "owner_principal_id" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "memory_tenant_owner_uniq" ON "memory" USING btree ("tenant_id","owner_principal_id");

-- Backfill: the old artifact_memory_per_owner_uniq index already guaranteed at
-- most one kind='memory' row per (tenant_id, owner_principal_id), so this is a
-- 1:1 copy, not a fold. Runs before the DROP INDEX so it can rely on that
-- invariant, and is idempotent (ON CONFLICT DO NOTHING) if replayed.
INSERT INTO "memory" ("tenant_id", "owner_principal_id", "content", "created_at", "updated_at")
SELECT "tenant_id", "owner_principal_id", "content", "created_at", "updated_at"
FROM "artifact"
WHERE "kind" = 'memory'
  AND "tenant_id" IS NOT NULL
  AND "owner_principal_id" IS NOT NULL
ON CONFLICT ("tenant_id", "owner_principal_id") DO NOTHING;

DROP INDEX IF EXISTS "artifact_memory_per_owner_uniq";
