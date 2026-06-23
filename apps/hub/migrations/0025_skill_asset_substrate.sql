ALTER TABLE "skill_version"
  DROP COLUMN "archive_object_key",
  ADD COLUMN "asset_id" text NOT NULL REFERENCES "asset"("id"),
  ADD COLUMN "asset_name" text NOT NULL;
