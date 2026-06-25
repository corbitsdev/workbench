-- CL-2321: capture deploy-time provenance (workflow package version, short git
-- sha, deploy timestamp) on the workflow_run deployment-index row. Nullable so
-- deployments that predate version capture remain valid (UI degrades to no
-- tooltip; failure logs simply omit version/sha).
ALTER TABLE "workflow_run" ADD COLUMN IF NOT EXISTS "meta" jsonb;
