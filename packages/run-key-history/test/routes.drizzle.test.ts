// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// diagnostics.drizzle.test.ts and @corbits/insights' routes-scope.test.ts.
// Proves the HTTP surface an operator actually reaches: /runs/:runAddress
// for a single run's lifecycle + status, /summary for tenant-wide counts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { inArray } from "drizzle-orm";

import { createDB, runMigrations, dropSchema, schema } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyRunKeyHistoryMigrations } from "../src/migrations";
import { createDrizzleRunKeyHistoryStore } from "../src/store";
import { runKeyHistory } from "../src/schema";
import { createRunKeyHistoryRoutes } from "../src/routes";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

const SCHEMA = "run_key_history_routes_test";
const TENANT = "tnt_run_key_history_routes";
const DEFINITION = "wfd_run_key_history_routes";

describeIfDb("createRunKeyHistoryRoutes", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await applyRunKeyHistoryMigrations(databaseUrl as string);
  });

  afterAll(async () => {
    // `applyRunKeyHistoryMigrations` always lands `run_key_history` in
    // its own fixed, global `run_key_history` schema -- unlike the
    // platform tables above, it is never scoped by `SCHEMA` -- so
    // dropping `SCHEMA` alone would leave this suite's rows behind for
    // the next run against the same shared e2e database to collide
    // with.
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await db
        .delete(runKeyHistory)
        .where(
          inArray(runKeyHistory.runAddress, [
            "run_diverged@run-key-history-routes.workbench.test",
            "run_summary_in_sync@run-key-history-routes.workbench.test",
            "run_summary_retired@run-key-history-routes.workbench.test",
            "run_summary_sidecar@run-key-history-routes.workbench.test",
          ]),
        );
    } finally {
      await close();
    }
    await dropSchema(target, { schema: SCHEMA });
  });

  async function withDb<T>(
    run: (db: ReturnType<typeof createDB>["db"]) => Promise<T>,
  ) {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      return await run(db);
    } finally {
      await close();
    }
  }

  function appFor(db: ReturnType<typeof createDB>["db"]) {
    const routes = createRunKeyHistoryRoutes({ db, requireGrant: allowAll });
    const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
      c.set("tenant", {
        id: TENANT,
        name: "Run Key History Routes Tenant",
        slug: "run-key-history-routes",
        domain: "run-key-history-routes.localhost",
        parentId: null,
        config: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      await next();
    };
    const app = new Hono<TenantEnv>();
    app.use("*", asTenant);
    app.route("/", routes);
    return app;
  }

  beforeAll(async () => {
    await withDb(async (db) => {
      await db
        .insert(schema.tenant)
        .values({
          id: TENANT,
          name: "Run Key History Routes Tenant",
          slug: "run-key-history-routes",
          domain: "run-key-history-routes.localhost",
        })
        .onConflictDoNothing();
      await db
        .insert(schema.workflowDefinition)
        .values({
          id: DEFINITION,
          tenantId: TENANT,
          name: "run-key-history-routes",
          status: "deployed",
        })
        .onConflictDoNothing();
    });
  });

  test("GET /runs/:runAddress returns 404 for an address with no workflow_run row", async () => {
    await withDb(async (db) => {
      const app = appFor(db);
      const res = await app.request(
        "/runs/run_missing@run-key-history-routes.workbench.test",
      );
      expect(res.status).toBe(404);
    });
  });

  test("GET /runs/:runAddress surfaces a diverged run's lifecycle and status", async () => {
    const address = "run_diverged@run-key-history-routes.workbench.test";
    await withDb(async (db) => {
      await db.insert(schema.workflowRun).values({
        id: "run_routes_diverged",
        definitionId: DEFINITION,
        tenantId: TENANT,
        address,
        publicKey: "key-a",
        status: "running",
      });
      const store = createDrizzleRunKeyHistoryStore(db);
      await store.recordObservedKey(address, "key-a");
      await store.recordObservedKey(address, "key-b");

      const app = appFor(db);
      const res = await app.request(`/runs/${encodeURIComponent(address)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: { state: string; recordedKey: string; platformKey: string };
        lifecycle: { publicKey: string; supersededAt: string | null }[];
      };
      expect(body.status.state).toBe("diverged");
      expect(body.status.recordedKey).toBe("key-b");
      expect(body.status.platformKey).toBe("key-a");
      expect(body.lifecycle).toHaveLength(2);
      expect(body.lifecycle[0]?.publicKey).toBe("key-a");
      expect(body.lifecycle[0]?.supersededAt).not.toBeNull();
      expect(body.lifecycle[1]?.publicKey).toBe("key-b");
      expect(body.lifecycle[1]?.supersededAt).toBeNull();
    });
  });

  test("GET /summary counts the calling tenant's runs by identity state", async () => {
    const inSyncAddress =
      "run_summary_in_sync@run-key-history-routes.workbench.test";
    const retiredAddress =
      "run_summary_retired@run-key-history-routes.workbench.test";
    await withDb(async (db) => {
      await db.insert(schema.workflowRun).values([
        {
          id: "run_summary_in_sync",
          definitionId: DEFINITION,
          tenantId: TENANT,
          address: inSyncAddress,
          publicKey: "key-a",
          status: "running",
        },
        {
          id: "run_summary_retired",
          definitionId: DEFINITION,
          tenantId: TENANT,
          address: retiredAddress,
          publicKey: null,
          status: "failed",
        },
      ]);
      const store = createDrizzleRunKeyHistoryStore(db);
      await store.recordObservedKey(inSyncAddress, "key-a");

      const app = appFor(db);
      const res = await app.request("/summary");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        inSync: number;
        retired: number;
        diverged: number;
        unacknowledged: number;
      };
      expect(body.inSync).toBeGreaterThanOrEqual(1);
      expect(body.retired).toBeGreaterThanOrEqual(1);
    });
  });

  test("GET /summary?sidecarId= narrows to runs on that sidecar", async () => {
    const sidecarId = "sc_run_key_history_routes_summary";
    const scopedAddress =
      "run_summary_sidecar@run-key-history-routes.workbench.test";
    await withDb(async (db) => {
      await db
        .insert(schema.sidecar)
        .values({
          id: sidecarId,
          tokenHashSha256: new Uint8Array(32).fill(2),
        })
        .onConflictDoNothing();
      await db.insert(schema.workflowRun).values({
        id: "run_summary_sidecar",
        definitionId: DEFINITION,
        tenantId: TENANT,
        address: scopedAddress,
        publicKey: "key-a",
        status: "running",
        sidecarId,
      });
      const store = createDrizzleRunKeyHistoryStore(db);
      await store.recordObservedKey(scopedAddress, "key-a");

      const app = appFor(db);
      const res = await app.request(`/summary?sidecarId=${sidecarId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        inSync: number;
        retired: number;
        diverged: number;
        unacknowledged: number;
      };
      expect(
        body.inSync + body.retired + body.diverged + body.unacknowledged,
      ).toBe(1);
      expect(body.inSync).toBe(1);
    });
  });
});
