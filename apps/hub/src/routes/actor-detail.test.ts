import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema as intx } from "@intx/db";
import * as wb from "../db/schema";
import type { HubDb } from "../db";
import { createActorDetailRouter } from "./actor-detail";
import { createActorSearchRouter } from "./actor-search";

function appWith(
  opts: { throwing?: boolean; pages?: unknown[][] } = {},
): Hono<{ Variables: { tenant: { id: string }; principal: { id: string } } }> {
  let call = 0;
  const db = drizzle(
    async () => {
      if (opts.throwing) throw new Error("db down");
      const rows = opts.pages?.[call] ?? [];
      call += 1;
      return { rows };
    },
    { schema: { ...intx, ...wb } },
  ) as unknown as HubDb;

  const app = new Hono<{
    Variables: { tenant: { id: string }; principal: { id: string } };
  }>();
  app.use("*", async (c, next) => {
    c.set("tenant", { id: "tn-1" });
    c.set("principal", { id: "prn-1" });
    await next();
  });
  app.route("/:principalId", createActorDetailRouter({ db }));
  return app;
}

describe("actor detail route", () => {
  it("returns 404 when no principal matches in the tenant", async () => {
    const res = await appWith({ pages: [[]] }).request("/prn_x");
    expect(res.status).toBe(404);
  });

  it("resolves a user principal to its identity", async () => {
    const res = await appWith({
      // pg-proxy returns positional row arrays in select-column order.
      pages: [
        [["prn_u1", "user", "active"]],
        [["Myra Ops", "myra@example.com"]],
      ],
    }).request("/prn_x");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      kind: string;
      displayName: string;
      email?: string;
      status: string;
    };
    expect(body).toEqual({
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      email: "myra@example.com",
      status: "active",
    });
  });

  it("resolves an agent principal to its identity", async () => {
    const res = await appWith({
      pages: [[["prn_a1", "agent", "deactivated"]], [["Oat"]]],
    }).request("/prn_x");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; displayName: string };
    expect(body.kind).toBe("agent");
    expect(body.displayName).toBe("Oat");
  });

  it("returns 500 when the lookup throws", async () => {
    const res = await appWith({ throwing: true }).request("/prn_x");
    expect(res.status).toBe(500);
  });
});

describe("actor route precedence (search vs detail)", () => {
  // Mirrors the mount order in apps/hub/src/index.ts: the static `/search`
  // segment must win over the dynamic `:principalId` detail route so
  // GET /actors/search never resolves the actor named "search".
  function composedApp(): Hono<{
    Variables: { tenant: { id: string }; principal: { id: string } };
  }> {
    const db = drizzle(
      async (query: string) => {
        // Search runs two queries (users, agents); detail runs a principal
        // lookup. Return empty rows for either — we assert on which router ran.
        if (query.includes('"principal"')) return { rows: [] };
        return { rows: [] };
      },
      { schema: { ...intx, ...wb } },
    ) as unknown as HubDb;

    const app = new Hono<{
      Variables: { tenant: { id: string }; principal: { id: string } };
    }>();
    app.use("*", async (c, next) => {
      c.set("tenant", { id: "tn-1" });
      c.set("principal", { id: "prn-1" });
      await next();
    });
    app.route("/actors/search", createActorSearchRouter({ db }));
    app.route("/actors/:principalId", createActorDetailRouter({ db }));
    return app;
  }

  it("routes GET /actors/search to the search router, not the :principalId detail route", async () => {
    const app = composedApp();
    // Search with a valid query returns 200 with an `actors` array.
    const search = await app.request("/actors/search?q=acme");
    expect(search.status).toBe(200);
    const body = (await search.json()) as { actors?: unknown };
    expect(Array.isArray(body.actors)).toBe(true);
    // The detail route would 404 on an unknown principal — proving "search"
    // was NOT treated as a principal id.
    expect(search.status).not.toBe(404);
  });

  it("still routes a real principal id to the detail route", async () => {
    const app = composedApp();
    const detail = await app.request("/actors/prn_missing");
    // Empty rows → detail returns 404 (not the search 200/actors shape).
    expect(detail.status).toBe(404);
  });
});
