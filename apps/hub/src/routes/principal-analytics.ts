import { getLogger } from "@intx/log";
import { type } from "arktype";
import { Hono, type Env } from "hono";
import { describeRoute, resolver } from "hono-openapi";

import type { HubDb } from "../db";
import { getPrincipalAnalytics } from "../services/principal-analytics";

const log = getLogger(["hub", "principal-analytics"]);

type PrincipalAnalyticsRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

const ToolRow = type({
  name: "string",
  calls: "number",
  errors: "number",
});

const CostSummary = type({
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWriteTokens: "number",
  thinkingTokens: "number",
  inferenceCalls: "number",
  toolCalls: "number",
});

const AnalyticsResponse = type({
  tools: ToolRow.array(),
  cost: CostSummary,
});
const ErrorResponse = type({
  error: { code: "string", message: "string" },
});

export type CreatePrincipalAnalyticsRouterDeps = {
  db: HubDb;
};

export function createPrincipalAnalyticsRouter({
  db,
}: CreatePrincipalAnalyticsRouterDeps): Hono<PrincipalAnalyticsRouteEnv> {
  const app = new Hono<PrincipalAnalyticsRouteEnv>();

  app.get(
    "/",
    describeRoute({
      tags: ["Activity"],
      summary: "A principal's tool-call breakdown and token/cost totals",
      description:
        "Aggregates the durable analytics_event facts for a principal — per-tool call counts (with error counts) and token-class totals (fresh input, cache read, cache write, output, thinking) — over the same attribution set as the activity timeline (the principal plus the synthetic principals of the agent instances it owns). Reads the raw fact table, not the loaded timeline window, so counts and cost are complete. Open intra-tenant like the activity timeline. Tenant and principal scope always come from the authenticated path.",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          description: "Tenant scope.",
          schema: { type: "string" },
        },
        {
          name: "principalId",
          in: "path",
          required: true,
          description: "Principal whose tool and cost analytics to aggregate.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "The principal's tool breakdown and cost totals",
          content: {
            "application/json": { schema: resolver(AnalyticsResponse) },
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
        const analytics = await getPrincipalAnalytics({
          db,
          tenantId: tenant.id,
          principalId: targetPrincipalId,
        });
        return c.json(analytics);
      } catch (error) {
        log.error(
          "Principal analytics failed for tenant {tenantId} principal {principalId}: {error}",
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
              message: "Failed to load principal analytics",
            },
          },
          500,
        );
      }
    },
  );

  return app;
}
