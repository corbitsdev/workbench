/**
 * Workbench `approval` → `workbench_approval` reconciliation for the 5a73d3cc
 * interchange pin (CL-3932).
 *
 * Interchange gained its OWN `approval` table at this pin (migration
 * `0038_chilly_blacklash.sql`, a bare `CREATE TABLE "approval"` with no
 * `IF NOT EXISTS`). The workbench has had its own `approval` table since
 * `apps/hub/migrations/0011_approval.sql` (the ask_principal / ReviewGate HITL
 * rail). `scripts/db-setup.ts` runs interchange migrations BEFORE the workbench
 * ones, so without intervention:
 *
 *   - Already-migrated DB (staging/prod): interchange 0038 throws
 *     `relation "approval" already exists` and aborts the whole deploy.
 *   - Fresh DB: interchange creates its shape first, the workbench's own
 *     `approval`-touching migrations then run against interchange's table.
 *
 * The fix has three parts, split by WHEN each can run:
 *
 *   1. Pre-interchange rename (`reconcileWorkbenchApprovalTable`, below, called
 *      before the interchange migrator): on an already-migrated DB the
 *      workbench-shaped `approval` (distinguished by the workbench-only
 *      `resource` column) is renamed to `workbench_approval`, and its
 *      primary-key constraint `approval_pkey` → `workbench_approval_pkey` so it
 *      does not collide with interchange's own approval PK index. On a fresh DB
 *      there is nothing to rename — this no-ops.
 *   2. The canonical `workbench_approval` table + index is created by workbench
 *      migration `0070_rename_approval_to_workbench_approval.sql` (which runs
 *      AFTER interchange, in the custom-migration pass). On a fresh DB it
 *      creates the table; after a rename it no-ops.
 *   3. A superseded-statement skip (`isSupersededApprovalIndexStatement`,
 *      applied by the custom-migration runner): workbench migration
 *      `0040_principal_activity_indexes.sql` still runs a
 *      `CREATE INDEX ... ON "approval" ("tenant_id","principal_id",...)`. On a
 *      fresh DB `approval` is now interchange's table, which has no
 *      `principal_id` column — Postgres validates index columns BEFORE the
 *      `IF NOT EXISTS` name check, so that statement ERRORS and aborts 0040
 *      (losing its eight other, valid indexes). The runner skips ONLY that
 *      one superseded statement when the live `approval` is not the workbench
 *      table; the equivalent index now lives on `workbench_approval` (0070).
 *
 * All parts are idempotent.
 */

export const WORKBENCH_APPROVAL_RECONCILE_STATEMENTS: readonly string[] = [
  `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'approval'
      AND column_name = 'resource'
  ) THEN
    ALTER TABLE "approval" RENAME TO "workbench_approval";
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'approval_pkey'
        AND conrelid = 'workbench_approval'::regclass
    ) THEN
      ALTER TABLE "workbench_approval"
        RENAME CONSTRAINT "approval_pkey" TO "workbench_approval_pkey";
    END IF;
  END IF;
END $$;`,
];

/**
 * Run the pre-interchange rename. `exec` runs one raw-SQL string (which may
 * contain a DO block); pass `(sql) => client.unsafe(sql)` for a postgres.js
 * client or `(sql) => client.exec(sql)` for PGlite.
 */
export async function reconcileWorkbenchApprovalTable(
  exec: (sql: string) => Promise<unknown>,
): Promise<void> {
  for (const statement of WORKBENCH_APPROVAL_RECONCILE_STATEMENTS) {
    await exec(statement);
  }
}

/**
 * True when a migration statement creates an index on the `approval` TABLE
 * (not `workbench_approval`). Such a statement — only `0040`'s
 * `approval_tenant_principal_created_idx` today — is superseded by the
 * workbench_approval rename: the runner skips it when the live `approval` is
 * interchange's table, where it would otherwise abort on the missing
 * `principal_id` column.
 */
export function isSupersededApprovalIndexStatement(statement: string): boolean {
  const isCreateIndex = /\bcreate\s+index\b/i.test(statement);
  // Match `ON "approval" (` / `ON approval (` but NOT `ON "workbench_approval"`.
  const targetsApprovalTable = /\bon\s+"?approval"?\s*\(/i.test(statement);
  return isCreateIndex && targetsApprovalTable;
}
