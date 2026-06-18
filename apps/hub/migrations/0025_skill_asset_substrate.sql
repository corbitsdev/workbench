ALTER TABLE "skill_version"
  DROP COLUMN "archive_object_key",
  ADD COLUMN "asset_id" uuid NOT NULL REFERENCES "asset"("id"),
  ADD COLUMN "asset_name" text NOT NULL;
