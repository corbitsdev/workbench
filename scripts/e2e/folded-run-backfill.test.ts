// DB-gated: skipped when no DATABASE_URL is reachable, mirroring every
// other drizzle/e2e suite in this repo. Runs against its own scratch
// database (CREATE/DROP DATABASE), never the shared e2e database other
// suites in `scripts/e2e` use — this test seeds raw rows straight into
// `chat`/`tasks`' own global Postgres schemas, which are NOT scoped by
// a per-test schema name the way the platform's own tables are, so
// isolation has to come from the database itself.
//
// This is the test for CL-6061's backfill follow-up: before
// `@corbits/folded-runs`' own `folded_run` marker table existed, a
// folded run was recorded only in the launching package's own table
// (`@corbits/chat`'s `workbench_launch`, `@corbits/tasks`' `task` and
// `task_leg`). Proves the coordinated backfill this repo chose —
// `scripts/db-setup.ts` sourcing seeds from each package's own
// exported lister and handing them to `@corbits/folded-runs`' own
// `backfillFoldedRunMarkers`, never a direct cross-schema SELECT
// inside `@corbits/folded-runs` itself, which would make it depend on
// two packages that already depend on it — actually closes the gap:
// pre-existing "old-shape" rows (workbench host, invited agent, task,
// and a chain leg) get a marker, and `listTopLevelRuns` excludes every
// one of them afterward while still listing a genuine deployment.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

import { dbTargetFromUrl } from "../db-setup.ts";
import { connectE2eDb, e2eDatabaseUrl, REPO_ROOT } from "./harness.ts";
import {
  applyFoldedRunsMigrations,
  backfillFoldedRunMarkers,
} from "../../packages/folded-runs/src/migrations";
import { listTopLevelRuns } from "../../packages/folded-runs/src/scope-routes";
import {
  applyChatMigrations,
  listWorkbenchLaunchFoldedRunIds,
} from "../../packages/chat/src/migrations";
import {
  applyTasksMigrations,
  listTaskFoldedRunIds,
} from "../../packages/tasks/src/migrations";

// `@intx/db` is not a root dependency (only `apps/hub` and the workspace
// packages declare it), so it is resolved dynamically through the
// hub's own dependency tree — the exact trick `../db-setup.ts` and
// `./harness.ts` already use for the same reason.
const HUB_DIR = path.join(REPO_ROOT, "apps", "hub");

interface IntxDb {
  createDB(config: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  }): { db: unknown; close: () => Promise<void> };
  runMigrations(
    target: {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
    },
    options: { schema: string },
  ): Promise<void>;
}

async function loadIntxDb(): Promise<IntxDb> {
  const resolved = Bun.resolveSync("@intx/db", HUB_DIR);
  return (await import(resolved)) as IntxDb;
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const TENANT = "tnt_backfill";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_folded_run_backfill_test`;
  return url.toString();
}

describeIfDb("folded-run backfill", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = await connectE2eDb(maintenanceUrl.toString());
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }

    const target = dbTargetFromUrl(scratchUrl);
    const intxDb = await loadIntxDb();
    await intxDb.runMigrations(target, { schema: "public" });
    await applyFoldedRunsMigrations(scratchUrl);
    await applyChatMigrations(scratchUrl);
    await applyTasksMigrations(scratchUrl);
  }, 30000);

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = await connectE2eDb(maintenanceUrl.toString());
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 30000);

  test("backfills markers for pre-existing workbench_launch/task/task_leg runs and the scoped listing excludes them", async () => {
    const target = dbTargetFromUrl(scratchUrl);
    const intxDb = await loadIntxDb();
    const { db, close } = intxDb.createDB(target);
    // Cast through `listTopLevelRuns`'s own parameter type rather than
    // importing `@intx/db`'s types directly, for the same
    // hub-dependency-resolution reason `loadIntxDb` exists — this file
    // has no direct dependency on `@intx/db` to import types from at
    // the top level either, only what it resolves dynamically.
    const typedDb = db as Parameters<typeof listTopLevelRuns>[0];
    const sql = await connectE2eDb(scratchUrl);
    try {
      await sql.unsafe(
        `INSERT INTO "tenant" ("id", "name", "slug", "domain") VALUES ($1, $2, $3, $4)`,
        [
          TENANT,
          "Backfill Tenant",
          "backfill-tenant",
          "backfill.workbench.test",
        ],
      );
      await sql.unsafe(
        `INSERT INTO "workflow_definition" ("id", "tenant_id", "name", "status") VALUES ($1, $2, $3, $4)`,
        ["wfd_researcher", TENANT, "researcher", "deployed"],
      );

      // A genuine top-level deployment, for contrast.
      await sql.unsafe(
        `INSERT INTO "workflow_run" ("id", "definition_id", "anchor_run_id", "tenant_id", "address", "status", "created_at") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          "run_deployment1",
          "wfd_researcher",
          "run_deployment1",
          TENANT,
          "run_deployment1@backfill.workbench.test",
          "running",
          new Date("2026-01-01T00:00:00.000Z"),
        ],
      );

      // Four "old-shape" folded runs — workbench host, invited agent,
      // task, and a chain leg — each self-anchored in workflow_run
      // exactly like the deployment above, but with NO folded_run
      // marker yet: only their launching package's own table records
      // them, simulating data written before CL-6061.
      const oldShapeIds = [
        "run_workbench_host_old",
        "run_invited_agent_old",
        "run_task_old",
        "run_chain_leg_old",
      ];
      for (const id of oldShapeIds) {
        await sql.unsafe(
          `INSERT INTO "workflow_run" ("id", "definition_id", "anchor_run_id", "tenant_id", "address", "status", "created_at") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            "wfd_researcher",
            id,
            TENANT,
            `${id}@backfill.workbench.test`,
            "running",
            new Date("2026-01-02T00:00:00.000Z"),
          ],
        );
      }

      await sql.unsafe(
        `INSERT INTO "chat"."workbench_launch" ("tenant_id", "instance_id", "current_run_id", "folded_body") VALUES ($1, $2, $3, $4)`,
        [
          TENANT,
          "run_workbench_host_old",
          "run_workbench_host_old",
          JSON.stringify({ systemPrompt: "host" }),
        ],
      );
      await sql.unsafe(
        `INSERT INTO "chat"."workbench_launch" ("tenant_id", "instance_id", "current_run_id", "folded_body") VALUES ($1, $2, $3, $4)`,
        [
          TENANT,
          "run_invited_agent_old",
          "run_invited_agent_old",
          JSON.stringify({ systemPrompt: "invited" }),
        ],
      );
      await sql.unsafe(
        `INSERT INTO "tasks"."task" ("id", "tenant_id", "principal_id", "definition_id", "agent_name", "prompt", "status", "run_id") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "task_old1",
          TENANT,
          "prn_1",
          "wfd_researcher",
          "Researcher",
          "Summarize",
          "running",
          "run_task_old",
        ],
      );
      await sql.unsafe(
        `INSERT INTO "tasks"."task_leg" ("id", "task_id", "tenant_id", "position", "definition_id", "prompt", "message_id", "run_id", "status") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          "tleg_old1",
          "task_old1",
          TENANT,
          1,
          "wfd_researcher",
          "Draft the follow-up",
          "chain:task_old1:1",
          "run_chain_leg_old",
          "done",
        ],
      );

      // Pre-backfill: no marker rows exist for the old-shape runs yet,
      // so the scoped listing (wrongly) still includes them.
      const beforeMarkers = await sql.unsafe(
        `SELECT id FROM "folded_runs"."folded_run" WHERE id = ANY($1)`,
        [oldShapeIds],
      );
      expect(beforeMarkers).toHaveLength(0);
      const beforeRows = await listTopLevelRuns(typedDb, TENANT);
      expect(beforeRows.map((row) => row.id).sort()).toEqual(
        [...oldShapeIds, "run_deployment1"].sort(),
      );

      const [workbenchLaunchSeeds, taskSeeds] = await Promise.all([
        listWorkbenchLaunchFoldedRunIds(scratchUrl),
        listTaskFoldedRunIds(scratchUrl),
      ]);
      expect(workbenchLaunchSeeds.map((s) => s.id).sort()).toEqual(
        ["run_workbench_host_old", "run_invited_agent_old"].sort(),
      );
      expect(taskSeeds.map((s) => s.id).sort()).toEqual(
        ["run_chain_leg_old", "run_task_old"].sort(),
      );

      const report = await backfillFoldedRunMarkers(scratchUrl, [
        ...workbenchLaunchSeeds,
        ...taskSeeds,
      ]);
      expect(report.applied).toBe(true);
      expect(report.inserted).toBe(4);

      // (a) marker rows now exist for every old-shape run.
      const afterMarkers = await sql.unsafe(
        `SELECT id, tenant_id AS "tenantId" FROM "folded_runs"."folded_run" WHERE id = ANY($1) ORDER BY id`,
        [oldShapeIds],
      );
      expect(afterMarkers.map((row) => row["id"])).toEqual(
        [...oldShapeIds].sort(),
      );
      for (const row of afterMarkers) {
        expect(row["tenantId"]).toBe(TENANT);
      }

      // (b) the scoped listing now excludes every one of them, while
      // the genuine deployment still lists.
      const afterRows = await listTopLevelRuns(typedDb, TENANT);
      expect(afterRows.map((row) => row.id)).toEqual(["run_deployment1"]);

      // Idempotent: a second call is a no-op, ledgered under its own
      // migration name.
      const secondReport = await backfillFoldedRunMarkers(scratchUrl, [
        ...workbenchLaunchSeeds,
        ...taskSeeds,
      ]);
      expect(secondReport).toEqual({ applied: false, inserted: 0 });
    } finally {
      await close();
      await sql.end();
    }
  });
});
