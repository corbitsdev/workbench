import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import {
  createRoutineRoutes,
  type CreateRoutineRoutesDeps,
  type RoutineLauncher,
} from "../src/routes";
import { createInMemoryRoutineStore } from "../src/store";

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

function fakeLauncher(): RoutineLauncher & {
  calls: number;
  lastInput: Record<string, unknown> | undefined;
} {
  let calls = 0;
  let lastInput: Record<string, unknown> | undefined;
  return {
    get calls() {
      return calls;
    },
    get lastInput() {
      return lastInput;
    },
    async launchRoutineRun(input) {
      calls += 1;
      lastInput = input.input;
      return { runId: `run_${calls}` };
    },
  };
}

function mountAs(
  routes: Hono<TenantEnv>,
  principalId: string,
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", principal(principalId));
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

function buildDeps(
  overrides: Partial<CreateRoutineRoutesDeps> = {},
): CreateRoutineRoutesDeps {
  return {
    store: createInMemoryRoutineStore(),
    launcher: fakeLauncher(),
    requireGrant: () => async (_c, next) => {
      await next();
    },
    ...overrides,
  };
}

const VALID_BODY = {
  name: "Research routine",
  definitionAssetId: "def_research",
  trigger: { kind: "daily", hour: 9, minute: 0 },
  scope: "bench",
  deliveryWorkbenchId: "ch_delivery",
  input: { topic: "AI coding agents", focus: "Competing launches" },
};

describe("run-now re-fires the routine's persisted input", () => {
  test("POST /routines/:id/run with an empty body forwards the routine's stored input to the launcher", async () => {
    const launcher = fakeLauncher();
    const deps = buildDeps({ launcher });
    const app = mountAs(createRoutineRoutes(deps), "user_1");

    const createResponse = await app.request("/routines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    const created = (await createResponse.json()) as Record<string, unknown>;

    const runResponse = await app.request(`/routines/${created["id"]}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(runResponse.status).toBe(201);
    expect(launcher.lastInput).toEqual({
      topic: "AI coding agents",
      focus: "Competing launches",
    });
  });
});
