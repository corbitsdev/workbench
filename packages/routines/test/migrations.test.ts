// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), mirroring
// @corbits/chat's `migrations.test.ts`. Runs against its own scratch
// database, never the developer's or the walking-skeleton suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyRoutineMigrations } from "../src/migrations";
import { createDrizzleRoutineStore } from "../src/store";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_routine_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb("applyRoutineMigrations", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchTarget = new URL(scratchUrl);
  const scratchDatabase = scratchTarget.pathname.replace(/^\//, "");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  // Deliberately agnostic to how many migration steps exist or what
  // they're named — this proves the schema and the idempotency
  // contract, not a specific migration sequence, so it stays true
  // whether the package ships one migration or many.
  test("applies every table into its own schema in final shape and is idempotent on a second run", async () => {
    const first = await applyRoutineMigrations(scratchUrl);
    expect(first.applied.length).toBeGreaterThan(0);

    const second = await applyRoutineMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual(first.applied.sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'routines' AND table_name IN ` +
          `('routine', 'routine_run', 'routine_draft')`,
      );
      expect(tables.map((row) => String(row["table_name"])).sort()).toEqual([
        "routine",
        "routine_draft",
        "routine_run",
      ]);

      const inPublic = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name IN ` +
          `('routine', 'routine_run', 'routine_draft')`,
      );
      expect(inPublic).toHaveLength(0);

      const columns = await sql.unsafe(
        `SELECT column_name FROM information_schema.columns ` +
          `WHERE table_schema = 'routines' AND table_name = 'routine'`,
      );
      const columnNames = columns.map((row) => String(row["column_name"]));
      expect(columnNames).toContain("next_fire_at");
      expect(columnNames).toContain("last_fire_at");
      expect(columnNames).toContain("deleted_at");
    } finally {
      await sql.end();
    }
  });

  test("a routine created on a freshly migrated database ends up fireable", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const db = drizzle(sql);
      const store = createDrizzleRoutineStore(db);
      const routine = await store.createRoutine({
        tenantId: "tnt_1",
        name: "Hourly",
        definitionId: "def_1",
        trigger: { kind: "interval", unit: "hours", every: 1 },
        scope: "bench",
        input: {},
        createdBy: "user_1",
      });

      expect(routine.nextFireAt).not.toBeNull();
      const due = await store.listDueRoutines(
        new Date((routine.nextFireAt as Date).getTime() + 1),
      );
      expect(due.map((row) => row.id)).toContain(routine.id);
    } finally {
      await sql.end();
    }
  });
});

// Separate database from the suites above: two replicas racing the same
// ledger must not collide with the idempotency test's own already-applied
// rows, and must start from a schema that has never seen this migration
// set before.
describeIfDb("applyRoutineMigrations concurrency", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  ).replace("_routine_migrations_test", "_routine_migrations_concurrent_test");
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  test("two replicas booting concurrently both complete without either crashing on a duplicate ledger insert", async () => {
    const [first, second] = await Promise.all([
      applyRoutineMigrations(scratchUrl),
      applyRoutineMigrations(scratchUrl),
    ]);

    const appliedNames = [...first.applied, ...second.applied].sort();
    expect(new Set(appliedNames).size).toBe(appliedNames.length);

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const ledgerRows = await sql.unsafe(
        `SELECT name FROM "routines"."routine_migrations" ORDER BY name`,
      );
      const ledgerNames = ledgerRows.map((row) => String(row["name"]));
      expect(new Set(ledgerNames).size).toBe(ledgerNames.length);
      expect(
        [
          ...appliedNames,
          ...first.alreadyApplied,
          ...second.alreadyApplied,
        ].sort(),
      ).toEqual([...ledgerNames, ...ledgerNames].sort());
    } finally {
      await sql.end();
    }
  }, 10000);
});
