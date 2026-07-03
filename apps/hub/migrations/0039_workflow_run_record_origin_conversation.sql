-- CL-2677: tag workflow runs with the conversation they were started from, so
-- the chat dock can filter "runs started in this chat". Nullable — a
-- direct-started run (no chat context) and every pre-existing row simply carry
-- NULL; no backfill.
ALTER TABLE "workflow_run_record" ADD COLUMN IF NOT EXISTS "origin_conversation_id" text;
