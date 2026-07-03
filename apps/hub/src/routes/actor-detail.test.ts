import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema as intx } from "@intx/db";
import * as wb from "../db/schema";
import type { HubDb } from "../db";
import { createActorDetailRouter } from "./actor-detail";

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
