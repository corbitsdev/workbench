-- CL-2490: composite indexes backing the per-principal activity timeline.
-- Each union branch filters on (tenant, principal-or-session) and orders by
-- its timestamp column with LIMIT k; these indexes keep every branch
-- index-bound. exists-scoped sources (session_mail, inference_turn) resolve
-- the principal through agent_session, so they index the session key instead.
--
-- The three WRITE-HOT tables (inference_turn, session_mail, analytics_event)
-- are NOT indexed here: a plain CREATE INDEX blocks writes for the build
-- duration, and this transactional runner cannot use CONCURRENTLY. They ship
-- in 0041 (no-transaction migration, CONCURRENTLY).

CREATE INDEX IF NOT EXISTS "agent_session_tenant_principal_created_idx" ON "agent_session" ("tenant_id", "principal_id", "created_at" DESC);
--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "grant_tenant_principal_created_idx" ON "grant" ("tenant_id", "principal_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credential_tenant_principal_created_idx" ON "credential" ("tenant_id", "principal_id", "created_at" DESC);
