-- Persisted chat attachment references. Uploads are diverted through the
-- parse-file route (stored as file artifacts, folded into the message text),
-- so the mail record itself carries no attachment — this table keys the
-- artifact back to its session_mail id BY VALUE so the transcript chip
-- survives reload. No FK into interchange tables.

CREATE TABLE IF NOT EXISTS "mail_attachment_ref" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "instance_id" text NOT NULL,
  "mail_id" text NOT NULL,
  "artifact_id" text NOT NULL,
  "name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "mail_attachment_ref_mail_artifact_uniq" UNIQUE ("mail_id", "artifact_id")
);

CREATE INDEX IF NOT EXISTS "mail_attachment_ref_instance_idx"
  ON "mail_attachment_ref" ("instance_id");
