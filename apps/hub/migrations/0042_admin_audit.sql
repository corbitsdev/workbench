-- CL-2735: compliance audit log. Records cross-principal activity reads (who
-- read whose timeline) and every admin grant/role mutation. Workbench-owned:
-- analytics_event is written only from the sidecar (agent.event), so hub-side
-- one-shots like an admin read are invisible there — a dedicated hub-owned
-- durable table is the correct store for a compliance surface. Touches NO
-- interchange-owned table; references principal ids by value only (no FK).
CREATE TABLE IF NOT EXISTS "admin_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "action" text NOT NULL,
  "actor_principal_id" text NOT NULL,
  "target_principal_id" text,
  "resource" text,
  "detail" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- The admin audit view lists newest-first within a tenant.
CREATE INDEX IF NOT EXISTS "admin_audit_tenant_created_idx"
  ON "admin_audit" ("tenant_id", "created_at" DESC);
