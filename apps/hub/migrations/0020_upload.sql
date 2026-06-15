-- Pre-workflow binary uploads (CL-1961).
--
-- A resource file (xlsx) is uploaded before the workflow run that consumes it
-- exists, so it cannot be stored as an artifact (artifacts require a sessionId
-- FK to workflow_run). Uploads are tenant-owned and referenced by id when the
-- run is created. BYTEA is sufficient at current scale; object storage is
-- explicitly out of scope.

CREATE TABLE IF NOT EXISTS "upload" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "filename" text NOT NULL,
  "mime_type" text NOT NULL,
  "content" bytea NOT NULL,
  "size" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
