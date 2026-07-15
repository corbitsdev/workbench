-- When a thread's first user message landed; NULL until then. Thread lists
-- hide never-used threads so "+ New chat" does not mutate the sidebar until
-- the chat is actually used (CL-3749). Stamped by the hub mail middleware
-- alongside the last_activity_at bump.
--
-- Backfill: every existing thread is treated as used, whatever its history —
-- hiding chats that predate this column would surprise their owners.
--
-- member_agent_instance is workbench-owned (no interchange tables touched).

ALTER TABLE "member_agent_instance"
  ADD COLUMN IF NOT EXISTS "first_message_at" timestamp;

UPDATE "member_agent_instance"
  SET "first_message_at" = "last_activity_at"
  WHERE "first_message_at" IS NULL;
