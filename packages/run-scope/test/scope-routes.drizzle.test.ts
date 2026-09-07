// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `@corbits/granola-tools`'s `credential-wiring-e2e.drizzle.test.ts`.
// Runs the real platform schema (`@intx/db`'s `runMigrations`, into its
// own named schema on the shared e2e database) so `listTopLevelRuns`
// is proven against real Postgres rows, not a hand-rolled fake `db`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDB, runMigrations, dropSchema } from "@intx/db";
import { schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/database-url";
import { listTopLevelRuns, listTopLevelRunFires } from "../src/scope-routes";
import { dbGate } from "../../../scripts/e2e/db-gate";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const SCHEMA = "run_scope_scope_routes_test";
const TENANT = "tnt_scope_routes";

describeIfDb("listTopLevelRuns", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  test("lists a genuine top-level deployment", async () => {
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

      await db.insert(schema.workflowRun).values({
        id: "run_deployment1",
        definitionId: "wfd_researcher",
        anchorRunId: "run_deployment1",
        tenantId: TENANT,
        address: "run_deployment1@scope-routes.workbench.test",
        status: "running",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });

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

  test("a child park row (no address) never appears", async () => {
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

  test("an array of tenant ids rolls up runs across every tenant in it, still excluding other tenants", async () => {
    const OTHER_TENANT = "tnt_scope_routes_other";
    const UNRELATED_TENANT = "tnt_scope_routes_unrelated";
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await db.insert(schema.tenant).values([
        {
          id: OTHER_TENANT,
          name: "Other Tenant",
          slug: "scope-routes-other-tenant",
          domain: "scope-routes-other.workbench.test",
        },
        {
          id: UNRELATED_TENANT,
          name: "Unrelated Tenant",
          slug: "scope-routes-unrelated-tenant",
          domain: "scope-routes-unrelated.workbench.test",
        },
      ]);
      await db.insert(schema.workflowRun).values([
        {
          id: "run_other_deployment1",
          definitionId: "wfd_researcher",
          anchorRunId: "run_other_deployment1",
          tenantId: OTHER_TENANT,
          address: "run_other_deployment1@scope-routes.workbench.test",
          status: "running",
          createdAt: new Date("2026-01-04T00:00:00.000Z"),
        },
        {
          id: "run_unrelated_deployment1",
          definitionId: "wfd_researcher",
          anchorRunId: "run_unrelated_deployment1",
          tenantId: UNRELATED_TENANT,
          address: "run_unrelated_deployment1@scope-routes.workbench.test",
          status: "running",
          createdAt: new Date("2026-01-04T00:00:00.000Z"),
        },
      ]);

      const rows = await listTopLevelRuns(db, [TENANT, OTHER_TENANT]);
      const ids = rows.map((row) => row.id).sort();
      expect(ids).toContain("run_deployment1");
      expect(ids).toContain("run_other_deployment1");
      expect(ids).not.toContain("run_unrelated_deployment1");

      expect(await listTopLevelRuns(db, [])).toEqual([]);
    } finally {
      await close();
    }
  });
});

const FIRES_SCHEMA = "run_scope_scope_routes_fires_test";
const FIRES_TENANT = "tnt_scope_routes_fires";

describeIfDb("listTopLevelRunFires", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: FIRES_SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: FIRES_SCHEMA });
  });

  test("excludes the resident never-fired deployment row, includes a routine fire with its routine's name, and falls back to the definition name for a directly-triggered deployment", async () => {
    const { db, close } = createDB({ ...target, schema: FIRES_SCHEMA });
    try {
      await db.insert(schema.tenant).values({
        id: FIRES_TENANT,
        name: "Scope Routes Fires Tenant",
        slug: "scope-routes-fires-tenant",
        domain: "scope-routes-fires.workbench.test",
      });
      await db.insert(schema.workflowDefinition).values([
        {
          id: "wfd_workbench_digest",
          tenantId: FIRES_TENANT,
          name: "workbench-digest",
          status: "deployed",
        },
        {
          id: "wfd_researcher",
          tenantId: FIRES_TENANT,
          name: "researcher",
          status: "deployed",
        },
      ]);

      // The resident deployment row: born "deployed", never triggered.
      // Plumbing, not a run — must never appear in the fires feed.
      await db.insert(schema.workflowRun).values({
        id: "run_never_fired1",
        definitionId: "wfd_workbench_digest",
        anchorRunId: "run_never_fired1",
        tenantId: FIRES_TENANT,
        address: "run_never_fired1@scope-routes-fires.workbench.test",
        status: "deployed",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      // A routine fire that `resolveRoutineFires` below recognizes as
      // a fire of "Pulse check" — must appear, carrying that routine's
      // name.
      await db.insert(schema.workflowRun).values({
        id: "run_fire1",
        definitionId: "wfd_workbench_digest",
        anchorRunId: "run_fire1",
        tenantId: FIRES_TENANT,
        address: "run_fire1@scope-routes-fires.workbench.test",
        status: "running",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      });

      // A plain deployment, triggered directly (no routine parent):
      // must appear, with no routine parent — the honest
      // definition-name fallback.
      await db.insert(schema.workflowRun).values({
        id: "run_direct_deployment1",
        definitionId: "wfd_researcher",
        anchorRunId: "run_direct_deployment1",
        tenantId: FIRES_TENANT,
        address: "run_direct_deployment1@scope-routes-fires.workbench.test",
        status: "running",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      });

      const resolveRoutineFires = async (runIds: readonly string[]) => {
        const fires = new Map<
          string,
          { routineId: string; routineName: string }
        >();
        if (runIds.includes("run_fire1")) {
          fires.set("run_fire1", {
            routineId: "rtn_pulse_check",
            routineName: "Pulse check",
          });
        }
        return fires;
      };

      const rows = await listTopLevelRunFires(
        db,
        FIRES_TENANT,
        resolveRoutineFires,
      );

      expect(rows.map((row) => row.id).sort()).toEqual(
        ["run_direct_deployment1", "run_fire1"].sort(),
      );

      const fire = rows.find((row) => row.id === "run_fire1");
      expect(fire).toMatchObject({
        definitionName: "workbench-digest",
        routineId: "rtn_pulse_check",
        routineName: "Pulse check",
        hasInFlightTurn: false,
        turns: [],
      });

      const direct = rows.find((row) => row.id === "run_direct_deployment1");
      expect(direct).toMatchObject({
        definitionName: "researcher",
        routineId: null,
        routineName: null,
        hasInFlightTurn: false,
        turns: [],
      });
    } finally {
      await close();
    }
  });

  test("with no resolveRoutineFires wired, fired runs still appear with no routine parent", async () => {
    const { db, close } = createDB({ ...target, schema: FIRES_SCHEMA });
    try {
      const rows = await listTopLevelRunFires(db, FIRES_TENANT, undefined);
      const ids = rows.map((row) => row.id);
      expect(ids).toContain("run_fire1");
      expect(ids).toContain("run_direct_deployment1");
      expect(ids).not.toContain("run_never_fired1");
      const fire = rows.find((row) => row.id === "run_fire1");
      expect(fire).toMatchObject({
        routineId: null,
        routineName: null,
      });
    } finally {
      await close();
    }
  });
});
