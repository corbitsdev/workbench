-- Allow tenant-scoped (admin-managed) workflow enablement rows alongside per-user rows.
--
-- A row with principal_id IS NULL means the workflow is enabled for all members
-- of the tenant. The GET /workflows/enabled query returns rows where
-- principal_id = :principalId OR principal_id IS NULL. Per-user rows keep the
-- existing behaviour; tenant-scoped rows are inserted by seedTenantWorkflows at
-- workbench creation time and require no per-user action.
--
-- The existing unique constraint (tenant_id, principal_id, kind) covers non-null
-- principal_id rows but is undefined for NULLs in PostgreSQL (NULLs are not equal
-- to each other, so two NULL rows satisfy the constraint). We add a separate
-- partial unique index on (tenant_id, kind) WHERE principal_id IS NULL to ensure
-- only one tenant-scoped row per workflow kind per tenant.

ALTER TABLE "workbench_workflows" ALTER COLUMN "principal_id" DROP NOT NULL;

CREATE UNIQUE INDEX "workbench_workflows_tenant_kind_null_principal_uniq"
  ON "workbench_workflows" ("tenant_id", "kind")
  WHERE "principal_id" IS NULL;
