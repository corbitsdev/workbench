// The one product table `@corbits/folded-runs` owns: a permanent marker
// row for every folded run this package's own `launchFoldedRun` ever
// creates — workbench hosts, invited agents, and tasks alike. Exists
// because `launchFoldedRun` self-anchors a folded run's `workflow_run`
// row exactly like a real top-level deployment anchor does (see
// `launch.ts`'s big comment on the `workflowRun` insert), so nothing in
// `workflow_run`'s own columns can tell the two families apart across a
// run's full lifecycle. This table is that permanent, workbench-owned
// discriminator: written unconditionally, inside the same launch
// transaction, by `launchFoldedRun` itself, so no caller can forget to
// mark its launch as folded. Lives in its own `folded_runs` Postgres
// schema, siloed the same way `@corbits/chat`'s tables are (see
// docs/package-migrations.md).
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const foldedRunsSchema = pgSchema("folded_runs");

/**
 * One row per folded run id, keyed on `workflow_run.id` (never a foreign
 * key — see `docs/package-migrations.md` on why a siloed package schema
 * references platform ids as plain text). A row's mere presence marks
 * that id as folded; there is no status or kind column because every
 * caller of `launchFoldedRun` (workbench hosts, invited agents, tasks)
 * needs exactly the same thing recorded here — which specific kind of
 * folded run it is lives in each caller's own table
 * (`@corbits/chat`'s `workbench_launch`, `@corbits/tasks`'s `task`), not
 * here.
 */
export const foldedRun = foldedRunsSchema.table("folded_run", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
