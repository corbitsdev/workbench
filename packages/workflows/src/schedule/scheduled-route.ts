// GET /api/tenants/:tenantId/workflows/scheduled — authored definitions
// whose frozen projection has a ScheduleTrigger, including `stopped`.
// POST /scheduled/:definitionId/run — fire that definition now.
import { Hono } from "hono";
import type { DB } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import {
  listScheduledWorkflowDefinitions,
  type ScheduledWorkflowDefinition,
} from "./list-scheduled";

export const RUN_NOW_CONTENT = "Run now.";

export type RunScheduledDefinition = (args: {
  tenantId: string;
  definitionId: string;
  principalId: string;
  fromDomain: string;
  content: string;
}) => Promise<{ runId: string }>;

export type CreateScheduledWorkflowRoutesDeps = {
  db: DB["db"];
  requireGrant: RequireGrant;
  runNow: RunScheduledDefinition;
  listScheduled?: (
    db: DB["db"],
    tenantId: string,
  ) => Promise<readonly ScheduledWorkflowDefinition[]>;
};

export function createScheduledWorkflowRoutes({
  db,
  requireGrant,
  runNow,
  listScheduled = listScheduledWorkflowDefinitions,
}: CreateScheduledWorkflowRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get(
    "/scheduled",
    requireGrant("workflow-definition:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const items = await listScheduled(db, tenant.id);
      return c.json({
        items: items.map((item) => ({
          definitionId: item.definitionId,
          assetId: item.assetId,
          name: item.name,
          tenantId: item.tenantId,
          status: item.status,
          cron: item.cron,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
      });
    },
  );

  app.post(
    "/scheduled/:definitionId/run",
    requireGrant("workflow-run:*", "create"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const definitionId = c.req.param("definitionId");
      const items = await listScheduled(db, tenant.id);
      const found = items.find((item) => item.definitionId === definitionId);
      if (found === undefined) {
        return c.json(
          {
            error: {
              code: "not_found",
              message: "Scheduled workflow not found",
            },
          },
          404,
        );
      }
      const { runId } = await runNow({
        tenantId: tenant.id,
        definitionId,
        principalId: principal.id,
        fromDomain: tenant.domain,
        content: RUN_NOW_CONTENT,
      });
      return c.json({ runId });
    },
  );

  return app;
}
