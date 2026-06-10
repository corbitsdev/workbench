-- Scope enabled-workflow rows per-principal, not per-tenant (CL-1450).
--
-- enabledWorkflow was unique on (tenant_id, kind). In the shared global org
-- tenant that makes one member's workflow enablement + credential/tool
-- assignments global and mutually overwritable, and a step could resolve and
-- run on another member's LLM credential. Re-key on (tenant_id, principal_id,
-- kind) so each member owns their own enablement and assignments.
--
-- Backfill: today every tenant is a single-user personal tenant, so the owning
-- principal is the one user principal in that tenant — unambiguous.

ALTER TABLE "workbench_workflows" ADD COLUMN IF NOT EXISTS "principal_id" text;

-- Attribute each existing row to its tenant's user principal.
UPDATE "workbench_workflows" ew
SET "principal_id" = (
  SELECT p.id
  FROM "principal" p
  WHERE p.tenant_id = ew.tenant_id
    AND p.kind = 'user'
  ORDER BY p.created_at ASC
  LIMIT 1
)
WHERE ew."principal_id" IS NULL;

-- Drop any row we could not attribute (a tenant with no user principal). These
-- are orphaned enablement config, not customer artifacts, and are re-creatable
-- by re-enabling the workflow; dropping them lets the NOT NULL + new unique
-- constraint apply cleanly rather than failing the deploy.
DELETE FROM "workbench_workflows" WHERE "principal_id" IS NULL;

ALTER TABLE "workbench_workflows" ALTER COLUMN "principal_id" SET NOT NULL;

-- Swap the uniqueness from (tenant_id, kind) to (tenant_id, principal_id, kind).
ALTER TABLE "workbench_workflows" DROP CONSTRAINT IF EXISTS "workbench_workflows_tenant_kind_uniq";
ALTER TABLE "workbench_workflows"
  ADD CONSTRAINT "workbench_workflows_tenant_principal_kind_uniq"
  UNIQUE ("tenant_id", "principal_id", "kind");
