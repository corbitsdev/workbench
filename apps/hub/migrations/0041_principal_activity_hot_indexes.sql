-- migrate:no-transaction
-- CL-2490: timeline indexes on the WRITE-HOT tables. inference_turn,
-- session_mail, and analytics_event take a row per model turn / message /
-- tool call, so a plain CREATE INDEX would block those writes for the build
-- duration during deploy. CONCURRENTLY cannot run inside a transaction, so
-- this file carries the no-transaction marker and each statement runs
-- standalone. The DROP guards clear an INVALID leftover if a prior
-- CONCURRENTLY build was interrupted (IF NOT EXISTS would otherwise skip it).

DROP INDEX CONCURRENTLY IF EXISTS "inference_turn_tenant_session_started_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "inference_turn_tenant_session_started_idx" ON "inference_turn" ("tenant_id", "session_id", "started_at" DESC);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "session_mail_tenant_session_created_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_mail_tenant_session_created_idx" ON "session_mail" ("tenant_id", "session_id", "created_at" DESC);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "analytics_event_tenant_principal_occurred_tool_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "analytics_event_tenant_principal_occurred_tool_idx" ON "analytics_event" ("tenant_id", "principal_id", "occurred_at" DESC) WHERE event_type = 'tool_call';
