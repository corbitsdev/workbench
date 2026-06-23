-- Skills are now stored in the Interchange `asset`/`agent_asset` tables.
-- The shadow `skill` and `skill_version` tables were introduced in PRs #282-284
-- and have been fully replaced by the native asset substrate in PR #285.
--
-- Any rows still present are shadow-table scaffolding from staging; drop unconditionally.
DROP TABLE IF EXISTS "skill_version";
--> statement-breakpoint
DROP TABLE IF EXISTS "skill";
