// The resolved-offerings route exists so an out-of-process caller
// (`workbench seed`, CL-7461) can deploy against exactly what the hub's
// own workflow deployer would deploy against — including offerings a
// tenant only inherits from an ancestor, which the tenant-owned
// `GET .../catalog/offerings` route never lists.
import { Hono } from "hono";
import { describe, expect, test } from "bun:test";

import type { TenantEnv } from "@intx/hub-api";
import type { ResolvedOffering } from "@intx/db";

import { createResolvedOfferingsRoutes } from "../src/resolved-offerings-routes";
import { offering } from "./fixtures";

const TENANT = {
  id: "bench-1",
  name: "Bench One",
  slug: "bench-one",
  domain: "bench-one.example",
  parentId: null,
  config: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function app(
  listOfferings: (tenantId: string) => Promise<readonly ResolvedOffering[]>,
  allow = true,
) {
  const host = new Hono<TenantEnv>();
  host.use("*", async (c, next) => {
    c.set("tenant", TENANT);
    await next();
  });
  host.route(
    "/",
    createResolvedOfferingsRoutes({
      listOfferings,
      requireGrant: () => async (c, next) => {
        if (!allow) {
          return c.json({ error: { code: "forbidden", message: "no" } }, 403);
        }
        return next();
      },
    }),
  );
  return host;
}

describe("GET resolved-offerings", () => {
  test("a denied grant is rejected before the offerings are read", async () => {
    const response = await app(async () => {
      throw new Error("must not be called when the grant is denied");
    }, false).request("/");
    expect(response.status).toBe(403);
  });

  test("lists both directly-owned and ancestor-inherited offerings, sorted by priority", async () => {
    const owned = offering({
      id: "owned",
      canonicalName: "thrifty",
      providerName: "globex",
      capabilities: ["plain-text"],
      priority: 2,
    });
    const inherited = offering({
      id: "inherited",
      canonicalName: "lavish",
      providerName: "acme",
      capabilities: ["plain-text"],
      priority: 1,
      inherited: true,
    });

    const response = await app(async (tenantId) => {
      expect(tenantId).toBe(TENANT.id);
      return [owned, inherited];
    }).request("/");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      offerings: {
        id: string;
        priority: number;
        modelId: string;
        providerId: string;
        origin: { tenantId: string; direct: boolean };
      }[];
    };
    expect(body.offerings.map((o) => o.id)).toEqual(["inherited", "owned"]);
    const inheritedEntry = body.offerings.find((o) => o.id === "inherited");
    expect(inheritedEntry?.origin).toEqual({
      tenantId: "parent-bench",
      direct: false,
    });
    const ownedEntry = body.offerings.find((o) => o.id === "owned");
    expect(ownedEntry?.origin).toEqual({ tenantId: TENANT.id, direct: true });
  });
});
