import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import { type } from "arktype";
import { Hono, type Env } from "hono";

import { loadPriceCatalog } from "../lib/pricing";
import { getActivityOverview } from "../services/activity-overview";

const log = getLogger(["hub", "activity"]);

type ActivityRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
    db: DB["db"];
  };
};

const OverviewQuery = type({
  "startDate?": "string",
  "endDate?": "string",
});

function optionalQuery(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export type CreateActivityRouterDeps = {
  db: DB["db"];
};

export function createActivityRouter({
  db,
}: CreateActivityRouterDeps): Hono<ActivityRouteEnv> {
  const app = new Hono<ActivityRouteEnv>();

  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  app.get("/overview", async (c) => {
    const tenant = c.get("tenant");
    const callerPrincipalId = c.get("principal")?.id ?? null;
    const queryInput: { startDate?: string; endDate?: string } = {};
    const startDate = optionalQuery(c.req.query("startDate"));
    const endDate = optionalQuery(c.req.query("endDate"));
    if (startDate !== undefined) queryInput.startDate = startDate;
    if (endDate !== undefined) queryInput.endDate = endDate;

    const query = OverviewQuery(queryInput);
    if (query instanceof type.errors) {
      return c.json(
        { error: { code: "bad_request", message: query.summary } },
        400,
      );
    }

    const range =
      query.startDate !== undefined || query.endDate !== undefined
        ? {
            ...(query.startDate !== undefined
              ? { startDate: query.startDate }
              : {}),
            ...(query.endDate !== undefined ? { endDate: query.endDate } : {}),
          }
        : undefined;

    try {
      // Best-effort: a cold/failed models.dev fetch must never fail the whole
      // overview — usage-by-person/workflow-type simply carry `cost: null`
      // (the honest "not priced" state), same as the shared cache's own
      // failure mode (CL-2749).
      const priceCatalog = await loadPriceCatalog().catch((error: unknown) => {
        log.warn("Activity overview: pricing catalog unavailable: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

      const overview = await getActivityOverview({
        db: c.get("db"),
        tenantId: tenant.id,
        callerPrincipalId,
        priceCatalog,
        ...(range !== undefined ? { range } : {}),
      });
      return c.json(overview);
    } catch (error) {
      log.error("Activity overview failed for tenant {tenantId}: {error}", {
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          error: {
            code: "internal_error",
            message: "Failed to load activity overview",
          },
        },
        500,
      );
    }
  });

  return app;
}
