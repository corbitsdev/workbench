-- Migrate data from workbench_session to workflow_run.
-- Maps userId to tenant/principal IDs by looking up personal tenant and principal.
-- This is a one-time migration; existing sessions are preserved as 'collateral-generation' workflows.

-- Older workbench_session rows may predate auth provisioning and therefore have
-- no matching personal tenant/principal. Preserve those rows under a deterministic
-- legacy tenant so the NOT NULL workflow_run scope columns are always populated.
INSERT INTO "tenant" (id, name, slug, domain, config, created_at, updated_at)
SELECT 'tenant_legacy_workbench', 'Legacy Workbench', 'legacy-workbench', 'legacy-workbench.localhost', '{}'::jsonb, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "tenant" WHERE slug = 'legacy-workbench');
--> statement-breakpoint
INSERT INTO "workflow_run" (id, tenant_id, principal_id, kind, status, input, created_at, updated_at)
SELECT
  ws.id,
  COALESCE(t.id, legacy_tenant.id) as tenant_id,
  COALESCE(p.id, ws.user_id, 'principal_legacy_workbench') as principal_id,
  'collateral-generation'::text as kind,
  CASE ws.status
    WHEN 'analyzing' THEN 'pending'::text
    WHEN 'reviewing' THEN 'running'::text
    WHEN 'generating' THEN 'running'::text
    WHEN 'improving' THEN 'running'::text
    WHEN 'exporting' THEN 'running'::text
    WHEN 'done' THEN 'done'::text
    ELSE 'pending'::text
  END as status,
  jsonb_build_object(
    'transcriptId', ws.transcript_id::text,
    'companyName', ws.company_name,
    'migratedFromStatus', ws.status
  ) as input,
  ws.created_at,
  ws.updated_at
FROM "workbench_session" ws
CROSS JOIN "tenant" legacy_tenant
LEFT JOIN "tenant" t ON t.slug = 'user-' || ws.user_id
LEFT JOIN "principal" p ON p.tenant_id = t.id AND p.kind = 'user' AND p.ref_id = ws.user_id
WHERE legacy_tenant.slug = 'legacy-workbench'
  AND NOT EXISTS (SELECT 1 FROM "workflow_run" WHERE "workflow_run".id = ws.id)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Update artifact FKs to point to workflow_run (via session_id which now references workflow_run).
-- The schema changes in 0008_workflow_run.sql already updated the constraints.
-- No data migration needed here since the IDs are preserved (1:1 mapping from workbench_session).
--> statement-breakpoint
-- Update pain_point FKs to point to workflow_run (via session_id which now references workflow_run).
-- No data migration needed; IDs are preserved.
--> statement-breakpoint
-- Now that workflow_run has data, add the new FK constraints
DO $$ BEGIN
 ALTER TABLE "artifact" ADD CONSTRAINT "artifact_session_id_workflow_run_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pain_point" ADD CONSTRAINT "pain_point_session_id_workflow_run_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
