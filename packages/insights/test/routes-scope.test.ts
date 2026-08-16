// DB-gated: skipped when no DATABASE_URL is reachable. Proves the
// workspace-rollup contract createInsightsRoutes' /usage, /activity,
// /tools, and /scope routes carry when `deps.db` is wired the same way
// apps/hub/src/index.ts wires it: a parent tenant's usage/activity
// aggregate equals the sum of its child workbenches' own numbers, and a
// child workbench's own route still returns just its own numbers (a
// leaf has no descendants to roll up). /scope proves the read-only
// counterpart a switcher reads: parent identity, own identity, and the
// sibling workbench list.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import postgres from "postgres";

import { createDB, schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { setupDatabase } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { createInsightsRoutes } from "../src/routes";
import { createMemoryUsageStore } from "../src/store";
import type { OverallUsageSummary } from "../src/queries";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_insights_routes_scope_test`;
  return url.toString();
}

function dbConfigFromUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

describeIfDb("createInsightsRoutes workspace rollup (deps.db wired)", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  const parentId = generateId("tenant");
  const childAId = generateId("tenant");
  const childBId = generateId("tenant");
  const unrelatedId = generateId("tenant");

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

    await setupDatabase(scratchUrl);

    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      await db.insert(schema.tenant).values({
        id: parentId,
        name: "Acme workspace",
        slug: `insights-scope-parent-${parentId}`,
        domain: `insights-scope-parent-${parentId}.localhost`,
      });
      await db.insert(schema.tenant).values([
        {
          id: childAId,
          name: "Acme — Support",
          slug: `insights-scope-child-a-${childAId}`,
          domain: `insights-scope-child-a-${childAId}.localhost`,
          parentId,
        },
        {
          id: childBId,
          name: "Acme — Sales",
          slug: `insights-scope-child-b-${childBId}`,
          domain: `insights-scope-child-b-${childBId}.localhost`,
          parentId,
        },
      ]);
      await db.insert(schema.tenant).values({
        id: unrelatedId,
        name: "Unrelated workbench",
        slug: `insights-scope-unrelated-${unrelatedId}`,
        domain: `insights-scope-unrelated-${unrelatedId}.localhost`,
      });
    } finally {
      await close();
    }
  }, 30000);

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

  function appFor(tenantId: string, db: ReturnType<typeof createDB>["db"]) {
    const routes = createInsightsRoutes({
      store,
      requireGrant: allowAll,
      db,
    });
    const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
      c.set("tenant", {
        id: tenantId,
        name: tenantNames[tenantId],
        slug: "s",
        domain: "d",
        parentId: tenantId === parentId ? null : parentId,
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

  const tenantNames: Record<string, string> = {
    [parentId]: "Acme workspace",
    [childAId]: "Acme — Support",
    [childBId]: "Acme — Sales",
    [unrelatedId]: "Unrelated workbench",
  };

  const store = createMemoryUsageStore();

  test("parent aggregate equals the sum of its child workbenches, per-workbench stays isolated", async () => {
    await store.insertUsage({
      id: "u1",
      tenantId: childAId,
      sessionId: "s1",
      turnId: "t1",
      model: "m",
      tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 },
    });
    await store.insertUsage({
      id: "u2",
      tenantId: childBId,
      sessionId: "s2",
      turnId: "t2",
      model: "m",
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 250, thinking: 0 },
    });
    await store.insertUsage({
      id: "u3",
      tenantId: unrelatedId,
      sessionId: "s3",
      turnId: "t3",
      model: "m",
      tokens: { input: 9999, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 },
    });

    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      const parentResponse = await appFor(parentId, db).request("/usage");
      expect(parentResponse.status).toBe(200);
      const parentSummary = (await parentResponse.json()) as OverallUsageSummary;

      const aResponse = await appFor(childAId, db).request("/usage");
      const aSummary = (await aResponse.json()) as OverallUsageSummary;
      const bResponse = await appFor(childBId, db).request("/usage");
      const bSummary = (await bResponse.json()) as OverallUsageSummary;

      expect(aSummary.turns).toBe(1);
      expect(aSummary.tokens.input).toBe(100);
      expect(bSummary.turns).toBe(1);
      expect(bSummary.tokens.output).toBe(250);

      // Parent (workspace) aggregate = sum of its child workbenches.
      expect(parentSummary.turns).toBe(aSummary.turns + bSummary.turns);
      expect(parentSummary.tokens.input).toBe(
        aSummary.tokens.input + bSummary.tokens.input,
      );
      expect(parentSummary.tokens.output).toBe(
        aSummary.tokens.output + bSummary.tokens.output,
      );
      // The unrelated root tenant never leaks into the parent's rollup.
      expect(parentSummary.tokens.input).toBe(100);
    } finally {
      await close();
    }
  });

  test("/scope reports parent identity and sibling workbenches for a child, and no parent for the workspace itself", async () => {
    const { db, close } = createDB(dbConfigFromUrl(scratchUrl));
    try {
      const childScopeResponse = await appFor(childAId, db).request("/scope");
      expect(childScopeResponse.status).toBe(200);
      const childScope = (await childScopeResponse.json()) as {
        tenantId: string;
        name: string;
        parent: { tenantId: string; name: string } | null;
        workbenches: { tenantId: string; name: string }[];
      };
      expect(childScope.tenantId).toBe(childAId);
      expect(childScope.parent).toEqual({ tenantId: parentId, name: "Acme workspace" });
      expect(childScope.workbenches.map((w) => w.tenantId).sort()).toEqual(
        [childAId, childBId].sort(),
      );

      const parentScopeResponse = await appFor(parentId, db).request("/scope");
      const parentScope = (await parentScopeResponse.json()) as {
        parent: unknown;
        workbenches: { tenantId: string; name: string }[];
      };
      expect(parentScope.parent).toBeNull();
      expect(parentScope.workbenches).toEqual([
        { tenantId: parentId, name: "Acme workspace" },
      ]);
    } finally {
      await close();
    }
  });
});
