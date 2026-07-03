-- CL-2490: composite indexes backing the per-principal activity timeline,
-- WORKBENCH-OWNED tables only. Interchange-owned tables (agent_session,
-- session_mail, inference_turn, grant, credential) are deliberately NOT
-- indexed here — we build on Interchange, we do not alter how it stores
-- data. If timeline query plans degrade on those sources at scale, the fix
-- is an upstream Interchange change, not a workbench migration.

CREATE INDEX IF NOT EXISTS "workflow_run_record_tenant_principal_created_idx" ON "workflow_run_record" ("tenant_id", "principal_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_tenant_principal_created_idx" ON "artifact" ("tenant_id", "principal_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_tenant_owner_principal_created_idx" ON "artifact" ("tenant_id", "owner_principal_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_version_author_created_idx" ON "artifact_version" ("author_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_tenant_principal_created_idx" ON "upload" ("tenant_id", "principal_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_tenant_owner_principal_updated_idx" ON "memory" ("tenant_id", "owner_principal_id", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_tenant_principal_created_idx" ON "approval" ("tenant_id", "principal_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "output_feedback_tenant_principal_created_idx" ON "output_feedback" ("tenant_id", "principal_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_event_tenant_principal_occurred_tool_idx" ON "analytics_event" ("tenant_id", "principal_id", "occurred_at" DESC) WHERE event_type = 'tool_call';
