import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema as intx } from "@intx/db";
import * as wb from "../db/schema";
import type { HubDb } from "../db";

mock.module("../lib/tenant-tools", () => ({
  listAvailableToolSummaries: () => Promise.resolve([]),
}));

const { createSearchRouter } = await import("./search");

function appWith(opts: { throwing?: boolean } = {}) {
  const db = drizzle(
    async () => {
      if (opts.throwing) throw new Error("db down");
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
  app.route("/", createSearchRouter({ db }));
  return app;
}

describe("search route", () => {
  it("returns 200 with a results/page/hasMore body", async () => {
    const res = await appWith().request("/?q=acme&page=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: unknown[];
      page: number;
      hasMore: boolean;
    };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.page).toBe(1);
    expect(typeof body.hasMore).toBe("boolean");
  });

  it("returns empty results for a blank query without erroring", async () => {
    const res = await appWith().request("/?q=");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });

  it("returns 500 when the search service throws", async () => {
    const res = await appWith({ throwing: true }).request("/?q=acme");
    expect(res.status).toBe(500);
  });
});
