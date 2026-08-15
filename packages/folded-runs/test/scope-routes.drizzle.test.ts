// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `@corbits/granola-tools`'s `credential-wiring-e2e.drizzle.test.ts`.
// Runs the real platform schema (`@intx/db`'s `runMigrations`, into its
// own named schema on the shared e2e database) alongside this
// package's own `folded_run` marker table
// (`applyFoldedRunsMigrations`), so `listTopLevelRuns` is proven
// against real Postgres rows and a real `NOT EXISTS` subquery, not a
// hand-rolled fake `db`.
//
// This is the test CL-6061 exists to write: a self-anchored folded run
// (channel host, invited agent, or task — indistinguishable from each
// other by `workflow_run`'s own columns, see `../src/launch.ts`'s big
// comment) never appears in this scoped listing, while a genuine
// top-level deployment run does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDB, runMigrations, dropSchema } from "@intx/db";
import { schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyFoldedRunsMigrations } from "../src/migrations";
import { foldedRun } from "../src/schema";
import { listTopLevelRuns } from "../src/scope-routes";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "folded_runs_scope_routes_test";
const TENANT = "tnt_scope_routes";

describeIfDb("listTopLevelRuns", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await applyFoldedRunsMigrations(databaseUrl as string);
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  test("excludes every folded run (channel host, invited agent, task) and lists a genuine deployment", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await db.insert(schema.tenant).values({
        id: TENANT,
        name: "Scope Routes Tenant",
        slug: "scope-routes-tenant",
        domain: "scope-routes.workbench.test",
      });
      await db.insert(schema.workflowDefinition).values({
        id: "wfd_researcher",
        tenantId: TENANT,
        name: "researcher",
        status: "deployed",
      });

      // A genuine top-level deployment: self-anchored, addressed, no
      // folded_run marker.
      await db.insert(schema.workflowRun).values({
        id: "run_deployment1",
        definitionId: "wfd_researcher",
        anchorRunId: "run_deployment1",
        tenantId: TENANT,
        address: "run_deployment1@scope-routes.workbench.test",
        status: "running",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      // Three folded runs — channel host, invited agent, task — all
      // self-anchored exactly like the deployment above, each marked
      // by its own `folded_run` row the way `launchFoldedRun` writes
      // it unconditionally at launch.
      const foldedIds = [
        "run_channel_host1",
        "run_invited_agent1",
        "run_task1",
      ];
      for (const id of foldedIds) {
        await db.insert(schema.workflowRun).values({
          id,
          definitionId: "wfd_researcher",
          anchorRunId: id,
          tenantId: TENANT,
          address: `${id}@scope-routes.workbench.test`,
          status: "running",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        });
        await db.insert(foldedRun).values({ id, tenantId: TENANT });
      }

      const rows = await listTopLevelRuns(db, TENANT);

      expect(rows.map((row) => row.id)).toEqual(["run_deployment1"]);
      expect(rows[0]).toMatchObject({
        id: "run_deployment1",
        definitionId: "wfd_researcher",
        definitionName: "researcher",
        tenantId: TENANT,
        status: "running",
      });
    } finally {
      await close();
    }
  });

  test("a child park row (no address) never appears, folded or not", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await db.insert(schema.workflowRun).values({
        id: "run_child_park1",
        definitionId: "wfd_researcher",
        anchorRunId: "run_deployment1",
        tenantId: TENANT,
        address: null,
        status: "running",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      });

      const rows = await listTopLevelRuns(db, TENANT);
      expect(rows.map((row) => row.id)).not.toContain("run_child_park1");
    } finally {
      await close();
    }
  });
});
