import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema as intx } from "@intx/db";
import * as wb from "../db/schema";
import type { HubDb } from "../db";
import { createActorSearchRouter } from "./actor-search";
import { ACTOR_SEARCH_MIN_QUERY_LENGTH } from "../services/actor-search";

function appWith(
  opts: { throwing?: boolean; rows?: unknown[][] } = {},
): Hono<{ Variables: { tenant: { id: string }; principal: { id: string } } }> {
  const db = drizzle(
    async () => {
      if (opts.throwing) throw new Error("db down");
      return { rows: opts.rows ?? [] };
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
  app.route("/", createActorSearchRouter({ db }));
  return app;
}

describe("actor search route", () => {
  it("returns 400 for a query below the minimum length", async () => {
    const short = "a".repeat(ACTOR_SEARCH_MIN_QUERY_LENGTH - 1);
    const res = await appWith().request(`/?q=${short}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("query_too_short");
  });

  it("returns 400 when q is missing", async () => {
    const res = await appWith().request("/");
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-numeric limit", async () => {
    const res = await appWith().request("/?q=acme&limit=abc");
    expect(res.status).toBe(400);
  });

  it("returns 200 with an actors array", async () => {
    const res = await appWith().request("/?q=acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actors: unknown[] };
    expect(body.actors).toEqual([]);
  });

  it("returns 500 when the search service throws", async () => {
    const res = await appWith({ throwing: true }).request("/?q=acme");
    expect(res.status).toBe(500);
  });
});
