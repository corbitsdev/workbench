CREATE TABLE IF NOT EXISTS "skill" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "visibility" text DEFAULT 'workspace' NOT NULL,
  "latest_version_id" uuid,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "archived_at" timestamp
);

CREATE TABLE IF NOT EXISTS "skill_version" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_id" uuid NOT NULL REFERENCES "skill"("id") ON DELETE cascade,
  "version" integer NOT NULL,
  "entrypoint_path" text NOT NULL,
  "archive_object_key" text NOT NULL,
  "manifest" jsonb NOT NULL,
  "checksum" text NOT NULL,
  "source" text DEFAULT 'file' NOT NULL,
  "file_count" integer DEFAULT 0 NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "skill_version_skill_id_version_uniq" UNIQUE ("skill_id", "version")
);
