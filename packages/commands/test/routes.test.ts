// Command HTTP surface: listing and execute, including the tenant-scoped
// channel membership gate on execute (CL-5768).
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import type { RequireGrant } from "@intx/hub-api";
import { createCommandRegistry } from "../src/registry";
import { createCommandRoutes } from "../src/routes";

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function principal(id: string) {
  return {
    id,
    tenantId: TENANT.id,
    kind: "user" as const,
    refId: id,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function mount(routes: ReturnType<typeof createCommandRoutes>) {
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", principal("prn_alice"));
    await next();
  });
  app.route("/", routes);
  return app;
}

const passGrant: RequireGrant = () => async (_c, next) => next();

describe("POST /commands/execute", () => {
  test("rejects a channel that does not belong to the tenant", async () => {
    const registry = createCommandRegistry();
    registry.registerCommand({
      name: "ping",
      description: "pong",
      handler: async () => ({ type: "message", text: "pong" }),
    });

    const app = mount(
      createCommandRoutes({
        registry,
        requireGrant: passGrant,
        channelBelongsToTenant: async () => false,
      }),
    );

    const response = await app.request("/commands/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "ping",
        channelId: "ins_foreign",
      }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("dispatches when the channel belongs to the tenant", async () => {
    const registry = createCommandRegistry();
    registry.registerCommand({
      name: "ping",
      description: "pong",
      handler: async () => ({ type: "message", text: "pong" }),
    });

    const app = mount(
      createCommandRoutes({
        registry,
        requireGrant: passGrant,
        channelBelongsToTenant: async (tenantId, channelId) =>
          tenantId === TENANT.id && channelId === "ins_mine",
      }),
    );

    const response = await app.request("/commands/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "ping",
        channelId: "ins_mine",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { type: string; text: string };
    expect(body).toEqual({ type: "message", text: "pong" });
  });
});
