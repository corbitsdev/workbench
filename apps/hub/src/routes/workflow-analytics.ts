import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { type } from "arktype";

import {
  getWorkflowAnalytics,
  getWorkflowRunBreakdown,
  WorkflowAnalyticsSchema,
  WorkflowRunBreakdownSchema,
} from "@workbench/analytics";

import type { HubDb } from "../db";
import { getRequestedUserContext } from "../lib/user-context";

const ErrorResponse = type({ error: "string" });

// CL-2670 workflow analytics facts route. Owner/tenant-gated: the caller sees
// aggregate insights (by workflow kind + by step kind) and per-run breakdowns
// only for a workbench it belongs to. All aggregation logic lives in
// @workbench/analytics; this route is a thin host.
export function createWorkflowAnalyticsRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  router.get(
    "/workflow-exec/analytics",
    describeRoute({
      tags: ["Workflows"],
      summary: "Workflow execution analytics",
      description:
        "Aggregate workflow-run insights derived from the run event logs: per workflow kind and per step kind — run/step counts, success rate, and average + median duration (and human-gate wait time). Optional `?tenantId=` selects a workbench the user belongs to; `?startDate=`/`?endDate=` bound the fact createdAt range.",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "startDate",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "endDate",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Aggregate workflow analytics for the workbench",
          content: {
            "application/json": { schema: resolver(WorkflowAnalyticsSchema) },
          },
        },
        403: {
          description: "User context not found or forbidden for the tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await getRequestedUserContext(
        db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const startDate = c.req.query("startDate");
      const endDate = c.req.query("endDate");
      const range =
        startDate !== undefined || endDate !== undefined
          ? {
              ...(startDate !== undefined ? { startDate } : {}),
              ...(endDate !== undefined ? { endDate } : {}),
            }
          : undefined;

      const result = await getWorkflowAnalytics({
        db,
        tenantId: context.tenantId,
        ...(range !== undefined ? { range } : {}),
      });
      return c.json(result);
    },
  );

  router.get(
    "/workflow-exec/analytics/runs/:runId",
    describeRoute({
      tags: ["Workflows"],
      summary: "Per-run workflow analytics breakdown",
      description:
        "The step-fact breakdown for a single run: each step's kind, outcome, duration, and gate-wait, plus the run-level outcome and duration. Scoped to a workbench the user belongs to.",
      parameters: [
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "tenantId",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "The run's fact breakdown",
          content: {
            "application/json": {
              schema: resolver(WorkflowRunBreakdownSchema),
            },
          },
        },
        404: {
          description: "No facts for the run in this workbench",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "User context not found or forbidden for the tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await getRequestedUserContext(
        db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const breakdown = await getWorkflowRunBreakdown({
        db,
        tenantId: context.tenantId,
        runId: c.req.param("runId"),
      });
      if (breakdown === null) return c.json({ error: "Not found" }, 404);
      return c.json(breakdown);
    },
  );

  return router;
}
