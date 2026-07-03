-- CL-2490: composite indexes backing the per-principal activity timeline.
-- Each union branch filters on (tenant, principal-or-session) and orders by
-- its timestamp column with LIMIT k; these indexes keep every branch
-- index-bound. exists-scoped sources (session_mail, inference_turn) resolve
-- the principal through agent_session, so they index the session key instead.

CREATE INDEX IF NOT EXISTS "inference_turn_tenant_session_started_idx" ON "inference_turn" ("tenant_id", "session_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "agent_session_tenant_principal_created_idx" ON "agent_session" ("tenant_id", "principal_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "session_mail_tenant_session_created_idx" ON "session_mail" ("tenant_id", "session_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "analytics_event_tenant_principal_occurred_tool_idx" ON "analytics_event" ("tenant_id", "principal_id", "occurred_at" DESC) WHERE event_type = 'tool_call';
CREATE INDEX IF NOT EXISTS "workflow_run_record_tenant_principal_created_idx" ON "workflow_run_record" ("tenant_id", "principal_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "artifact_tenant_principal_created_idx" ON "artifact" ("tenant_id", "principal_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "artifact_tenant_owner_principal_created_idx" ON "artifact" ("tenant_id", "owner_principal_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "artifact_version_author_created_idx" ON "artifact_version" ("author_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "upload_tenant_principal_created_idx" ON "upload" ("tenant_id", "principal_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "memory_tenant_owner_principal_updated_idx" ON "memory" ("tenant_id", "owner_principal_id", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "approval_tenant_principal_created_idx" ON "approval" ("tenant_id", "principal_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "output_feedback_tenant_principal_created_idx" ON "output_feedback" ("tenant_id", "principal_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "grant_tenant_principal_created_idx" ON "grant" ("tenant_id", "principal_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "credential_tenant_principal_created_idx" ON "credential" ("tenant_id", "principal_id", "created_at" DESC);
