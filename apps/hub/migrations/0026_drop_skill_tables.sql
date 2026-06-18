-- Skills are now stored in the Interchange `asset`/`agent_asset` tables.
-- The shadow `skill` and `skill_version` tables were introduced in PRs #282-284
-- and have been fully replaced by the native asset substrate in PR #285.
--
-- Pre-flight: both tables must be empty before this migration runs.
-- If either table still has rows, the asset migration step was skipped
-- and this migration should not proceed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'skill' AND table_schema = 'public')
     AND (SELECT COUNT(*) FROM "skill") > 0 THEN
    RAISE EXCEPTION 'skill table still has rows — migrate data to asset table before dropping';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'skill_version' AND table_schema = 'public')
     AND (SELECT COUNT(*) FROM "skill_version") > 0 THEN
    RAISE EXCEPTION 'skill_version table still has rows — migrate data to asset table before dropping';
  END IF;
END $$;

DROP TABLE IF EXISTS "skill_version";
DROP TABLE IF EXISTS "skill";
