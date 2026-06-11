-- Enforce one row per (artifact_id, version) on artifact_version.
--
-- The inline artifact tools (artifact_write, CL-1668) bump an artifact's version
-- by reading the current version and inserting version+1. Without this
-- constraint, two concurrent writers (e.g. an agent and a human editing the same
-- artifact) could both insert the same version number, silently corrupting the
-- revision history. artifact_write now performs the read under a row lock; this
-- constraint is the database-level backstop so a race fails loudly instead.

ALTER TABLE "artifact_version"
  DROP CONSTRAINT IF EXISTS "artifact_version_artifact_id_version_uniq";
--> statement-breakpoint
ALTER TABLE "artifact_version"
  ADD CONSTRAINT "artifact_version_artifact_id_version_uniq"
  UNIQUE ("artifact_id", "version");
