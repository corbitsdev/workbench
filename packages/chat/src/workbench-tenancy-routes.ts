// `POST /kinds`, mounted outside the hub's tenant-prefixed routes:
// answers "which of these tenant ids are workbench child tenancies",
// the one fact `workbench_tenancy` holds that no native tenant route
// exposes (see `./workbench-tenancy.ts`). A caller's own tenant ids come
// from `/api/me/principals`, which spans every tenant they belong to —
// asking about them here needs no per-tenant grant, only a signed-in
// user, the same bar `@workbench/onboarding`'s `/provision` route sets
// for its own cross-tenant read.
import type { AppEnv } from "@intx/hub-api";
import { Hono } from "hono";
import { type } from "arktype";
import { makeErrorEnvelope } from "@workbench/hub-client";

import type { WorkbenchTenancyStore } from "./workbench-tenancy";

const TenantIdsBody = type({
  tenantIds: "string[]",
});

export type CreateWorkbenchTenancyRoutesDeps = {
  tenancy: Pick<WorkbenchTenancyStore, "listWorkbenchTenantIds">;
};

export function createWorkbenchTenancyRoutes(
  deps: CreateWorkbenchTenancyRoutesDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/kinds", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage: "Authentication required",
        }),
        401,
      );
    }

    const body = TenantIdsBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "invalid_body",
          userMessage: body.summary,
        }),
        400,
      );
    }

    const workbenchTenantIds = await deps.tenancy.listWorkbenchTenantIds(
      body.tenantIds,
    );
    return c.json({ workbenchTenantIds: [...workbenchTenantIds] });
  });

  return app;
}
