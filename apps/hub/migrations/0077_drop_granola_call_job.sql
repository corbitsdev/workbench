-- CL-4203: drop the legacy granola_call_job table after cutover to work_unit
-- kind granola_call. 0076 copied open rows into work_unit and marked specialized
-- rows done; runtime has used work_unit only via the granola-call-job-queue
-- facade since that cutover. This is irreversible data loss for any residual
-- rows still on granola_call_job (expected to be all status=done).
DROP INDEX IF EXISTS "granola_call_job_tenant_note_uniq";
--> statement-breakpoint
DROP INDEX IF EXISTS "granola_call_job_status_next_attempt_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "granola_call_job_lease_until_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "granola_call_job";
