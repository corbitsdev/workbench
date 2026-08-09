// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), mirroring this package's own
// `migrations.test.ts`. Runs against its own scratch database, never
// the developer's or the walking-skeleton suite's.
//
// `store.test.ts` proves `markFailedFire`'s conditional write against
// the in-memory store. This exercises the real
// `createDrizzleRoutineStore` path: backoff after failure, and the
// edit-wins case where a concurrent trigger change must survive a
// stale mark untouched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyRoutineMigrations } from "../src/migrations";
import { backoffMsForFailure, createDrizzleRoutineStore } from "../src/store";

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
  "createDrizzleRoutineStore: claimRoutineFire / markFailedFire",
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

    test("markFailedFire backs off nextFireAt when nothing has changed since the claim", async () => {
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

        const result = await store.markFailedFire({
          routineId: routine.id,
          tenantId: TENANT_ID,
          claimedNextFireAt,
          failedAt: fireAt,
          reason: "launch exploded",
        });
        expect(result?.deadLettered).toBe(false);
        expect(result?.nextFireAt?.toISOString()).toBe(
          new Date(fireAt.getTime() + backoffMsForFailure(1)).toISOString(),
        );

        const after = await store.getRoutine(TENANT_ID, routine.id);
        expect(after?.consecutiveFailures).toBe(1);
        const runs = await store.listRunsForRoutine(TENANT_ID, routine.id);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.triggeredBy).toBe("schedule-failed");
      } finally {
        await sql.end();
      }
    });

    test("markFailedFire is a no-op when a trigger edit already moved nextFireAt", async () => {
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

        const edited = await store.updateRoutine(TENANT_ID, routine.id, {
          trigger: { kind: "interval", unit: "minutes", every: 30 },
        });
        const editedNextFireAt = assertDate(edited.nextFireAt);
        expect(editedNextFireAt.getTime()).not.toBe(
          claimedNextFireAt.getTime(),
        );

        const result = await store.markFailedFire({
          routineId: routine.id,
          tenantId: TENANT_ID,
          claimedNextFireAt,
          failedAt: fireAt,
          reason: "stale",
        });
        expect(result).toBeUndefined();

        const afterMark = await store.getRoutine(TENANT_ID, routine.id);
        expect(afterMark?.nextFireAt?.toISOString()).toBe(
          editedNextFireAt.toISOString(),
        );
      } finally {
        await sql.end();
      }
    });
  },
);
