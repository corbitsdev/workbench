-- Dedupe key for hub-written mailbox rows — workflow gate mail (keyed
-- gate:<runId>:<signalName>) and Myra triage handoffs (keyed
-- triage:<source row id>) — so a retried or re-projected job can never write
-- the same logical message twice. Nullable: delivered external mail carries no
-- key and stays unconstrained; the partial unique index scopes dedupe to keyed
-- rows per (tenant, principal).

ALTER TABLE "principal_mailbox"
  ADD COLUMN IF NOT EXISTS "message_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "principal_mailbox_message_key_uniq"
  ON "principal_mailbox" ("tenant_id", "principal_id", "message_key")
  WHERE "message_key" IS NOT NULL;
