import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";

import { createWorkbenchTenancyRoutes } from "../src/workbench-tenancy-routes";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";

const asUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", { id: "user_1", email: "alice@example.com" } as never);
  await next();
};

function mountAuthenticated(routes: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser);
  app.route("/", routes);
  return app;
}

describe("POST /kinds", () => {
  test("reports which of the given tenant ids are workbench tenancies", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const { tenantId: workbenchTenantId } = await tenancy.createWorkbenchTenant(
      {
        parentTenantId: "tnt_bench",
        workbenchId: "ins_general",
        name: "General",
        creatorUserId: "user_1",
      },
    );
    const app = mountAuthenticated(createWorkbenchTenancyRoutes({ tenancy }));

    const response = await app.request("/kinds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantIds: ["tnt_bench", workbenchTenantId, "tnt_unrelated"],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { workbenchTenantIds: string[] };
    expect(body.workbenchTenantIds).toEqual([workbenchTenantId]);
  });

  test("an empty tenantIds list is answered, not rejected", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const app = mountAuthenticated(createWorkbenchTenancyRoutes({ tenancy }));

    const response = await app.request("/kinds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantIds: [] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { workbenchTenantIds: string[] };
    expect(body.workbenchTenantIds).toEqual([]);
  });

  test("rejects an unauthenticated request", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const app = new Hono<AppEnv>();
    app.route("/", createWorkbenchTenancyRoutes({ tenancy }));

    const response = await app.request("/kinds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantIds: [] }),
    });

    expect(response.status).toBe(401);
  });

  test("rejects a malformed body", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const app = mountAuthenticated(createWorkbenchTenancyRoutes({ tenancy }));

    const response = await app.request("/kinds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantIds: "not-an-array" }),
    });

    expect(response.status).toBe(400);
  });
});
