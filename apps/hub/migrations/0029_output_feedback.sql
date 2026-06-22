CREATE TABLE IF NOT EXISTS "output_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "instance_id" text,
  "subject_kind" text NOT NULL,
  "subject_id" text NOT NULL,
  "rating" integer NOT NULL CHECK (rating IN (1, -1)),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "output_feedback_principal_subject_uniq" UNIQUE ("principal_id", "subject_id", "subject_kind")
);

CREATE INDEX IF NOT EXISTS "output_feedback_subject_idx" ON "output_feedback" ("subject_kind", "subject_id");
