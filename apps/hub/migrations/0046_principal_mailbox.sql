-- Durable per-principal mailbox for mail addressed to human users (usr_
-- addresses). Written by the workbench persistMail override; read by the
-- /me/inbox route. `raw` is the RFC 2822 frame verbatim; subject/from are
-- cached list headers parsed at write time.

CREATE TABLE IF NOT EXISTS "principal_mailbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "address" text NOT NULL,
  "direction" text NOT NULL,
  "raw" bytea NOT NULL,
  "subject" text,
  "from_address" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "read_at" timestamp
);

CREATE INDEX IF NOT EXISTS "principal_mailbox_principal_created_idx"
  ON "principal_mailbox" ("tenant_id", "principal_id", "created_at");
