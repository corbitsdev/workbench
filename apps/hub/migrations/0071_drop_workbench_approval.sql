-- CL-3938: retire the legacy workbench_approval table. Its entire code path
-- (the workbench-owned SSE/mutation routes and the ask_principal / ReviewGate
-- rail that read/wrote it) was deleted in #1134 — the native approval rail
-- (interchange's own "approval" table, resolved via registerSignalCorrelation
-- and served over apps/hub/src/routes/native-approvals.ts +
-- routes/approval-notifications.ts) is now the sole approval mechanism.
-- workbench_approval, created in 0011_approval.sql and renamed in 0070
-- (CL-3932, to avoid the name collision with interchange's own "approval"
-- table), is orphaned: nothing reads or writes it. This is irreversible data
-- loss for any pending/historical rows in that table on deploy.
DROP INDEX IF EXISTS "approval_tenant_principal_created_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "workbench_approval";
