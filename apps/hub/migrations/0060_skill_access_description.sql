-- Adds a description column to the workbench-owned skill_access table so
-- listSkills can surface a one-line summary per skill (used by the chat
-- composer's slash-command autocomplete) without a heavy per-skill fetch of
-- the git-stored SKILL.md content. Nullable: skills created before this
-- migration, or without a description at create time, read back as null.
-- skill_access is workbench-owned (no interchange asset/principal tables touched).

ALTER TABLE "skill_access" ADD COLUMN IF NOT EXISTS "description" text;
