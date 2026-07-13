-- Structured entity references (the reading pane's "Related" action row) move
-- from an X-Workbench-Refs frame header to a first-class jsonb column. Nullable:
-- external mail and hub-written rows with no refs leave it NULL. The read path
-- re-validates the blob through MailboxRefSchema, so a row whose stored shape
-- no longer validates degrades to no refs rather than failing the inbox read.

ALTER TABLE "principal_mailbox"
  ADD COLUMN IF NOT EXISTS "refs" jsonb;
