-- Idempotency key for programmatically-delivered mailbox items — specifically the
-- workflow "a workflow needs you" gate mail (one item per gate occurrence, keyed
-- `gate:<runId>:<signalName>`). Nullable: human/agent mail written by the
-- persistMail override carries no key and stays unconstrained. The partial unique
-- index dedupes keyed inserts so a re-projected open gate never writes twice.

ALTER TABLE "principal_mailbox"
  ADD COLUMN IF NOT EXISTS "message_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "principal_mailbox_message_key_uniq"
  ON "principal_mailbox" ("message_key")
  WHERE "message_key" IS NOT NULL;
