import { getLogger } from "@intx/log";
import { type } from "arktype";
import { Hono, type Env } from "hono";
import { describeRoute, resolver } from "hono-openapi";

import type { HubDb } from "../db";
import {
  getPrincipalRoster,
  RosterInstanceSchema,
  RosterRunSchema,
} from "../services/principal-roster";

const log = getLogger(["hub", "principal-roster"]);

type PrincipalRosterRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

const RosterResponse = type({
  instances: RosterInstanceSchema.array(),
  runs: RosterRunSchema.array(),
});
const ErrorResponse = type({
  error: { code: "string", message: "string" },
});

export type CreatePrincipalRosterRouterDeps = {
  db: HubDb;
};

export function createPrincipalRosterRouter({
  db,
}: CreatePrincipalRosterRouterDeps): Hono<PrincipalRosterRouteEnv> {
  const app = new Hono<PrincipalRosterRouteEnv>();

  app.get(
    "/",
    describeRoute({
      tags: ["Activity"],
      summary: "A principal's owned agent instances and workflow runs",
      description:
        "Lists the concrete entities a principal owns — the agent instances mapped to it via `member_agent_instance`, and the workflow runs it started (`workflow_run_record.principalId`) — each carrying enough identity to deep-link to that entity's own trace. Open intra-tenant like the activity timeline: any tenant member can read any principal's roster within that tenant. Tenant and principal scope always come from the authenticated path.",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          description: "Tenant scope of the roster.",
          schema: { type: "string" },
        },
        {
          name: "principalId",
          in: "path",
          required: true,
          description: "Principal whose owned agents and runs to list.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "The principal's agent instances and workflow runs",
          content: {
            "application/json": { schema: resolver(RosterResponse) },
          },
        },
        400: {
          description: "Missing principalId",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      const targetPrincipalId = c.req.param("principalId");
      if (targetPrincipalId === undefined || targetPrincipalId === "") {
        return c.json(
          { error: { code: "bad_request", message: "Missing principalId" } },
          400,
        );
      }

      try {
        const roster = await getPrincipalRoster({
          db,
          tenantId: tenant.id,
          principalId: targetPrincipalId,
        });
        return c.json(roster);
      } catch (error) {
        log.error(
          "Principal roster failed for tenant {tenantId} principal {principalId}: {error}",
          {
            tenantId: tenant.id,
            principalId: targetPrincipalId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return c.json(
          {
            error: {
              code: "internal_error",
              message: "Failed to load principal roster",
            },
          },
          500,
        );
      }
    },
  );

  return app;
}
