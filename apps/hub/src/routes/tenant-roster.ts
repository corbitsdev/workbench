import { getLogger } from "@intx/log";
import { type } from "arktype";
import { Hono, type Env } from "hono";
import { describeRoute, resolver } from "hono-openapi";

import type { HubDb } from "../db";
import {
  getTenantRoster,
  RosterInstanceSchema,
  RosterRunSchema,
} from "../services/principal-roster";

const log = getLogger(["hub", "tenant-roster"]);

type TenantRosterRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
  };
};

const RosterResponse = type({
  instances: RosterInstanceSchema.array(),
  runs: RosterRunSchema.array(),
});
const ErrorResponse = type({
  error: { code: "string", message: "string" },
});

export type CreateTenantRosterRouterDeps = {
  db: HubDb;
};

export function createTenantRosterRouter({
  db,
}: CreateTenantRosterRouterDeps): Hono<TenantRosterRouteEnv> {
  const app = new Hono<TenantRosterRouteEnv>();

  app.get(
    "/",
    describeRoute({
      tags: ["Activity"],
      summary: "A tenant's agent instances and recent workflow runs",
      description:
        "Lists every agent instance owned in the tenant (via `member_agent_instance`, each carrying its synthetic principal id to deep-link to that instance's trace) and the tenant's most recent workflow runs (`workflow_run_record`, owner-agnostic, most-recent first). Powers the dashboard-level, clickable Agents and Recent-runs surfaces. Tenant scope comes from the authenticated path; visible to any tenant member, matching the tenant-wide analytics surfaces.",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          description: "Tenant scope of the roster.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "The tenant's agent instances and recent workflow runs",
          content: {
            "application/json": { schema: resolver(RosterResponse) },
          },
        },
        500: {
          description: "Roster read failed",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      try {
        const roster = await getTenantRoster({ db, tenantId: tenant.id });
        return c.json(roster);
      } catch (error) {
        log.error("Tenant roster failed for tenant {tenantId}: {error}", {
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          {
            error: {
              code: "internal_error",
              message: "Failed to load tenant roster",
            },
          },
          500,
        );
      }
    },
  );

  return app;
}
