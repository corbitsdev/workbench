// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), mirroring
// @corbits/chat's `migrations.test.ts`. Runs against its own scratch
// database, never the developer's or the walking-skeleton suite's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyRoutineMigrations, routineMigrations } from "../src/migrations";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_routine_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

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
  });

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
  });

  test("applies both tables and is idempotent on a second run", async () => {
    const first = await applyRoutineMigrations(scratchUrl);
    expect(first.applied).toEqual([
      "0001_routine",
      "0002_routine_run",
      "0003_routine_next_fire_at",
      "0004_routine_soft_delete",
    ]);

    const second = await applyRoutineMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([
      "0001_routine",
      "0002_routine_run",
      "0003_routine_next_fire_at",
      "0004_routine_soft_delete",
    ]);

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name IN ` +
          `('routine', 'routine_run')`,
      );
      expect(tables.map((row) => String(row["table_name"])).sort()).toEqual([
        "routine",
        "routine_run",
      ]);
    } finally {
      await sql.end();
    }
  });
});

describeIfDb("0003_routine_next_fire_at backfill", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchTarget = new URL(scratchUrl);
  const scratchDatabase = `${scratchTarget.pathname.replace(/^\//, "")}_backfill`;
  const backfillScratchUrl = (() => {
    const url = new URL(scratchUrl);
    url.pathname = `/${scratchDatabase}`;
    return url.toString();
  })();

  beforeAll(async () => {
    const maintenanceUrl = new URL(backfillScratchUrl);
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
  });

  afterAll(async () => {
    const maintenanceUrl = new URL(backfillScratchUrl);
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
  });

  test("a routine created before the migration is still due and fireable afterwards", async () => {
    // Simulate a pre-existing deployment: only 0001/0002 have run, and
    // a routine was created under that schema (no next_fire_at column
    // existed yet).
    const sql = postgres(backfillScratchUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const [routineMigration, routineRunMigration] = routineMigrations;
      if (routineMigration === undefined || routineRunMigration === undefined) {
        throw new Error("expected the routine and routine_run migrations");
      }
      await sql.unsafe(routineMigration.sql);
      await sql.unsafe(routineRunMigration.sql);
      await sql`
        INSERT INTO "routine" (
          "id", "tenant_id", "name", "definition_id", "trigger",
          "scope", "input", "enabled", "created_by"
        ) VALUES (
          'rtn_legacy', 'tnt_1', 'Legacy hourly', 'def_1',
          ${sql.json({ kind: "interval", unit: "hours", every: 1 })},
          'bench', ${sql.json({})}, true, 'user_1'
        )
      `;
    } finally {
      await sql.end();
    }

    // Now bring the database up to date, exactly as a real deploy
    // would — the pre-existing row never goes through `createRoutine`.
    await applyRoutineMigrations(backfillScratchUrl);

    const sql2 = postgres(backfillScratchUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const [row] = await sql2`
        SELECT "next_fire_at" FROM "routine" WHERE "id" = 'rtn_legacy'
      `;
      expect(row).toBeDefined();
      const nextFireAt = row?.["next_fire_at"] as Date | null;
      expect(nextFireAt).not.toBeNull();
      // Fireable: due within the routine's own hourly cadence, not
      // stranded at NULL forever.
      expect((nextFireAt as Date).getTime()).toBeLessThanOrEqual(
        Date.now() + 3_600_000,
      );
    } finally {
      await sql2.end();
    }
  });
});
