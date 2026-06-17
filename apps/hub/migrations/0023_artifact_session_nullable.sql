-- Make session_id nullable on artifact.
-- Agent-driven tools (artifact_link_file, artifact_create, write_artifact, etc.)
-- create tenant/principal-scoped artifacts outside of any workflow_run.
-- The column was historically NOT NULL when everything was workflow-scoped.
-- workflow paths continue to supply a valid workflow_run id.
-- See CL-1679.
ALTER TABLE "artifact" ALTER COLUMN "session_id" DROP NOT NULL;