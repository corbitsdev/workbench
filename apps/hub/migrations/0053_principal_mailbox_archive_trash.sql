-- CL-3514: inbox folder markers on durable principal_mailbox rows.
-- archived_at and trashed_at are mutually used views: trash wins when set;
-- default inbox lists exclude trashed rows; unread counts exclude trashed rows.

ALTER TABLE "principal_mailbox"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;

ALTER TABLE "principal_mailbox"
  ADD COLUMN IF NOT EXISTS "trashed_at" timestamptz;

CREATE INDEX IF NOT EXISTS "principal_mailbox_principal_active_created_idx"
  ON "principal_mailbox" ("tenant_id", "principal_id", "created_at")
  WHERE "trashed_at" IS NULL AND "archived_at" IS NULL;

CREATE INDEX IF NOT EXISTS "principal_mailbox_principal_archived_created_idx"
  ON "principal_mailbox" ("tenant_id", "principal_id", "created_at")
  WHERE "archived_at" IS NOT NULL AND "trashed_at" IS NULL;

CREATE INDEX IF NOT EXISTS "principal_mailbox_principal_trashed_created_idx"
  ON "principal_mailbox" ("tenant_id", "principal_id", "created_at")
  WHERE "trashed_at" IS NOT NULL;