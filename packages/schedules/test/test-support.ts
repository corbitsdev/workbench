// Shared test harness: a fake `ScheduleLauncher`, a tenant/principal
// injecting mount, and the deps builder every route test file drives
// `createScheduleRoutes` through. Mirrors `packages/chat/test/test-support.ts`.
// Not a production module — lives in `test/` only.
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import type { ScheduleLauncher } from "../src/launcher";
import { createInMemoryScheduleStore } from "../src/store";
import type { CreateScheduleRoutesDeps } from "../src/routes";

export const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export function principal(id: string) {
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

export function fakeLauncher(): ScheduleLauncher & {
  calls: {
    tenantId: string;
    scheduleId: string;
    workflowDefinitionId: string;
    createdBy: string;
    input: unknown;
  }[];
} {
  const calls: {
    tenantId: string;
    scheduleId: string;
    workflowDefinitionId: string;
    createdBy: string;
    input: unknown;
  }[] = [];
  return {
    calls,
    async launchScheduledRun(input) {
      calls.push(input);
      return {
        instanceId: `ins_${calls.length}`,
        address: `ins_${calls.length}@acme.example`,
      };
    },
  };
}

export function mountAs(
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

export function buildDeps(
  overrides: Partial<CreateScheduleRoutesDeps> = {},
): CreateScheduleRoutesDeps {
  return {
    store: createInMemoryScheduleStore(),
    launcher: fakeLauncher(),
    requireGrant: () => async (_c, next) => {
      await next();
    },
    ...overrides,
  };
}
