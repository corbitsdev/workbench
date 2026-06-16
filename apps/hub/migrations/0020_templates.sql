-- Generic versioned template store. `kind` identifies the template type
-- (e.g. 'gamma'). `config` is a jsonb blob whose shape is kind-specific.
-- Only the highest version per template is surfaced in the UI.

CREATE TABLE "template" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "kind" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE "template_version" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_id" uuid NOT NULL REFERENCES "template"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "name" text NOT NULL,
  "config" jsonb NOT NULL,
  "author_id" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "template_version_template_id_version_uniq" UNIQUE ("template_id", "version")
);
