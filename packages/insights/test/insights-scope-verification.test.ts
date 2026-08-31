// Critique verification for cl-6099-insights-rollup.
// 1. createPostgresUsageStore.listUsageByTenants: the ANY(array) SQL path
//    has no coverage on the branch (routes-scope.test.ts substitutes the
//    memory store). Proves multi-tenant reads, isolation, empty-array,
//    and that a quote-bearing tenant id is parameterized (no injection).
// 2. resolveScope recursion: a workbench with a workbench child tenancy is
//    NOT a leaf — its /usage now includes the grandchild's rows, and the
//    workspace parent's aggregate includes them too.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import postgres from "postgres";

import { createDB, schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { setupDatabase } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { createInsightsRoutes } from "../src/routes";
import { createPostgresUsageStore } from "../src/pg-store";
import { createMemoryUsageStore } from "../src/store";
import type { OverallUsageSummary } from "../src/queries";
import { dbGate } from "../../../scripts/e2e/db-gate";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_critique_scope_verification`;
  return url.toString();
}

function dbConfigFromUrl(u: string) {
  const url = new URL(u);
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

const tokens = (input: number, output: number) => ({
  input,
  cacheRead: 0,
  cacheWrite: 0,
  output,
  thinking: 0,
});

describeIfDb("pg-store listUsageByTenants (real Postgres)", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");
  let pg: ReturnType<typeof createPostgresUsageStore>;

  beforeAll(async () => {
    const m = new URL(scratchUrl);
    m.pathname = "/postgres";
    const maintenance = postgres(m.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
    await setupDatabase(scratchUrl);
    pg = createPostgresUsageStore(scratchUrl);
  }, 60000);

  afterAll(async () => {
    await pg.close();
    const m = new URL(scratchUrl);
    m.pathname = "/postgres";
    const maintenance = postgres(m.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  });

  test("multi-tenant ANY() returns exactly the scoped tenants' rows", async () => {
    await pg.store.insertUsage({
      id: generateId("inferenceTurn"),
      tenantId: "wb-a",
      sessionId: "s1",
      turnId: "t1",
      model: "m",
      tokens: tokens(10, 0),
    });
    await pg.store.insertUsage({
      id: generateId("inferenceTurn"),
      tenantId: "wb-b",
      sessionId: "s2",
      turnId: "t2",
      model: "m",
      tokens: tokens(0, 20),
    });
    await pg.store.insertUsage({
      id: generateId("inferenceTurn"),
      tenantId: "wb-other",
      sessionId: "s3",
      turnId: "t3",
      model: "m",
      tokens: tokens(999, 999),
    });

    const both = await pg.store.listUsageByTenants(["wb-a", "wb-b"]);
    expect(both.map((r) => r.tenantId).sort()).toEqual(["wb-a", "wb-b"]);

    const single = await pg.store.listUsageByTenants(["wb-a"]);
    expect(single).toHaveLength(1);
  });

  test("provider and reported cost survive the Postgres round trip", async () => {
    const inserted = await pg.store.insertUsage({
      id: generateId("inferenceTurn"),
      tenantId: "wb-priced",
      sessionId: "s-priced",
      turnId: "t-priced",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: tokens(12, 34),
      reportedCostUsd: 0.000364,
    });

    expect(inserted).toMatchObject({
      provider: "anthropic",
      reportedCostUsd: 0.000364,
    });
    const [listed] = await pg.store.listUsageByTenants(["wb-priced"]);
    expect(listed).toMatchObject({
      provider: "anthropic",
      reportedCostUsd: 0.000364,
    });
  });

  test("empty scope returns no rows", async () => {
    expect(await pg.store.listUsageByTenants([])).toEqual([]);
  });

  test("quote-bearing tenant id is parameterized, matches nothing, throws nothing", async () => {
    const rows = await pg.store.listUsageByTenants([
      "x'; DROP TABLE insights.usage_turn; --",
    ]);
    expect(rows).toEqual([]);
    // Table still there.
    expect(await pg.store.listUsageByTenants(["wb-a"])).toHaveLength(1);
  });
});

describeIfDb("resolveScope recursion over workbench child tenancies", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  ).replace("_critique_scope_verification", "_critique_recursion_verification");
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  const workspaceId = generateId("tenant");
  const workbenchId = generateId("tenant");
  const workbenchTenantId = generateId("tenant");

  const allowAll: RequireGrant = () => async (_c, next) => {
    await next();
  };
  const store = createMemoryUsageStore();

  beforeAll(async () => {
    const m = new URL(scratchUrl);
    m.pathname = "/postgres";
    const maintenance = postgres(m.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
    await setupDatabase(scratchUrl);

    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      await db.insert(schema.tenant).values({
        id: workspaceId,
        name: "Workspace",
        slug: `crit-ws-${workspaceId}`,
        domain: `crit-ws-${workspaceId}.localhost`,
      });
      await db.insert(schema.tenant).values({
        id: workbenchId,
        name: "Bench",
        slug: `crit-wb-${workbenchId}`,
        domain: `crit-wb-${workbenchId}.localhost`,
        parentId: workspaceId,
      });
      // Same shape packages/chat's workbench tenancy mint produces:
      // a tenant whose parent is the workbench (chat routes.ts:837).
      await db.insert(schema.tenant).values({
        id: workbenchTenantId,
        name: "chn_deadbeef",
        slug: `crit-ch-${workbenchTenantId}`,
        domain: `crit-ch-${workbenchTenantId}.localhost`,
        parentId: workbenchId,
      });
    } finally {
      await close();
    }

    await store.insertUsage({
      id: "wbrow",
      tenantId: workbenchId,
      sessionId: "s1",
      turnId: "t1",
      model: "m",
      tokens: tokens(100, 0),
    });
    await store.insertUsage({
      id: "chrow",
      tenantId: workbenchTenantId,
      sessionId: "s2",
      turnId: "t2",
      model: "m",
      tokens: tokens(7, 0),
    });
  }, 60000);

  afterAll(async () => {
    const m = new URL(scratchUrl);
    m.pathname = "/postgres";
    const maintenance = postgres(m.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  });

  function appFor(tenantId: string, db: ReturnType<typeof createDB>["db"]) {
    const routes = createInsightsRoutes({ store, requireGrant: allowAll, db });
    const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
      c.set("tenant", {
        id: tenantId,
        name: "n",
        slug: "s",
        domain: "d",
        parentId: tenantId === workspaceId ? null : workspaceId,
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

  test("a workbench with a workbench child tenancy is not a leaf: its /usage includes the grandchild's rows", async () => {
    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      const res = await appFor(workbenchId, db).request("/usage");
      const summary = (await res.json()) as OverallUsageSummary;
      // 107 = workbench's own 100 + workbench tenant's 7. The branch test's
      // "a leaf has no descendants" claim does not hold for a workbench
      // that has minted a workbench tenancy.
      expect(summary.tokens.input).toBe(107);
      expect(summary.turns).toBe(2);
    } finally {
      await close();
    }
  });

  test("workspace aggregate includes grandchildren (recursive, not direct children only)", async () => {
    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      const res = await appFor(workspaceId, db).request("/usage");
      const summary = (await res.json()) as OverallUsageSummary;
      expect(summary.tokens.input).toBe(107);
    } finally {
      await close();
    }
  });
});
