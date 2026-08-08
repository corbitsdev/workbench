// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), mirroring this package's own
// `migrations.test.ts`. Runs against its own scratch database, never
// the developer's or the walking-skeleton suite's.
//
// `store.test.ts` proves `compensateFailedFire`'s compare-and-restore
// against the in-memory store, which is atomic only because JS is
// single-threaded — it says nothing about whether Postgres's own
// timestamp comparison, round-tripped through drizzle, actually
// behaves the same way. This exercises the real `createDrizzleRoutineStore`
// path: an ordinary restore, and the edit-wins case where a concurrent
// trigger change must survive a stale compensation untouched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyRoutineMigrations } from "../src/migrations";
import { createDrizzleRoutineStore } from "../src/store";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_routine_store_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const TENANT_ID = "tnt_1";

function assertDate(value: Date | null): Date {
  if (value === null) throw new Error("expected a non-null Date");
  return value;
}

describeIfDb(
  "createDrizzleRoutineStore: claimRoutineFire / compensateFailedFire",
  () => {
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
        await maintenance.unsafe(
          `DROP DATABASE IF EXISTS "${scratchDatabase}"`,
        );
        await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
      } finally {
        await maintenance.end();
      }
      await applyRoutineMigrations(scratchUrl);
    });

    afterAll(async () => {
      const maintenanceUrl = new URL(scratchUrl);
      maintenanceUrl.pathname = "/postgres";
      const maintenance = postgres(maintenanceUrl.toString(), {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        await maintenance.unsafe(
          `DROP DATABASE IF EXISTS "${scratchDatabase}"`,
        );
      } finally {
        await maintenance.end();
      }
    });

    test("compensateFailedFire restores nextFireAt when nothing has changed since the claim", async () => {
      const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
      try {
        const store = createDrizzleRoutineStore(drizzle(sql));
        const routine = await store.createRoutine({
          tenantId: TENANT_ID,
          name: "Hourly",
          definitionId: "def_1",
          trigger: { kind: "interval", unit: "hours", every: 1 },
          scope: "bench",
          input: {},
          createdBy: "user_1",
        });
        const fireAt = assertDate(routine.nextFireAt);
        const claimed = await store.claimRoutineFire(routine.id, fireAt);
        const claimedNextFireAt = assertDate(claimed?.nextFireAt ?? null);

        await store.compensateFailedFire(routine.id, fireAt, claimedNextFireAt);

        const restored = await store.getRoutine(TENANT_ID, routine.id);
        expect(restored?.nextFireAt?.toISOString()).toBe(fireAt.toISOString());
      } finally {
        await sql.end();
      }
    });

    test("compensateFailedFire is a no-op when a trigger edit already moved nextFireAt", async () => {
      const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
      try {
        const store = createDrizzleRoutineStore(drizzle(sql));
        const routine = await store.createRoutine({
          tenantId: TENANT_ID,
          name: "Hourly again",
          definitionId: "def_1",
          trigger: { kind: "interval", unit: "hours", every: 1 },
          scope: "bench",
          input: {},
          createdBy: "user_1",
        });
        const fireAt = assertDate(routine.nextFireAt);
        const claimed = await store.claimRoutineFire(routine.id, fireAt);
        const claimedNextFireAt = assertDate(claimed?.nextFireAt ?? null);

        // A trigger edit lands during the failure window, after the
        // claim but before the launch's failure is handled.
        const edited = await store.updateRoutine(TENANT_ID, routine.id, {
          trigger: { kind: "interval", unit: "minutes", every: 30 },
        });
        const editedNextFireAt = assertDate(edited.nextFireAt);
        expect(editedNextFireAt.getTime()).not.toBe(
          claimedNextFireAt.getTime(),
        );

        // The conditional UPDATE's WHERE no longer matches (nextFireAt
        // moved), so this must not clobber the edit's newer value.
        await store.compensateFailedFire(routine.id, fireAt, claimedNextFireAt);

        const afterCompensation = await store.getRoutine(TENANT_ID, routine.id);
        expect(afterCompensation?.nextFireAt?.toISOString()).toBe(
          editedNextFireAt.toISOString(),
        );
      } finally {
        await sql.end();
      }
    });
  },
);
