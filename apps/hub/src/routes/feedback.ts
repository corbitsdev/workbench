import { eq, and } from "drizzle-orm";
import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import { FeedbackRequest, FeedbackListResponse } from "@workbench/shared";
import { outputFeedback } from "../db/schema";
import type { HubDb } from "../db";
import { resolveInstanceOwner } from "../lib/instance-ownership";
import { requestBodySchema } from "../lib/openapi";

const log = getLogger(["hub", "feedback"]);

const ErrorResponse = type({ error: "string" });

export function createFeedbackRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.post(
    "/instances/:instanceId/feedback",
    describeRoute({
      tags: ["Feedback"],
      summary: "Submit thumbs up/down feedback for an agent or workflow output",
      description:
        "Records a rating (1 = thumbs up, -1 = thumbs down) for a turn-part or workflow-step output. An existing rating from the same principal is replaced via upsert.",
      parameters: [
        {
          name: "instanceId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        content: {
          "application/json": { schema: requestBodySchema(FeedbackRequest) },
        },
      },
      responses: {
        201: { description: "Feedback recorded" },
        400: {
          description: "Invalid request body",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description:
            "Instance not found, or caller is not a principal of its tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const instanceId = c.req.param("instanceId");

      const raw = await c.req.json().catch(() => null);
      const body = FeedbackRequest(raw);
      if (body instanceof type.errors) {
        return c.json({ error: body.summary }, 400);
      }

      const caller = await resolveInstanceOwner(db, instanceId, userId);
      if (!caller) {
        return c.json({ error: "Instance not found" }, 404);
      }

      await db
        .insert(outputFeedback)
        .values({
          tenantId: caller.tenantId,
          principalId: caller.principalId,
          instanceId,
          subjectKind: body.subjectKind,
          subjectId: body.subjectId,
          rating: body.rating,
        })
        .onConflictDoUpdate({
          target: [
            outputFeedback.principalId,
            outputFeedback.subjectId,
            outputFeedback.subjectKind,
          ],
          set: { rating: body.rating, updatedAt: new Date() },
        });

      return c.json({}, 201);
    },
  );

  app.get(
    "/instances/:instanceId/feedback",
    describeRoute({
      tags: ["Feedback"],
      summary:
        "Get all feedback ratings submitted by the caller for this instance",
      parameters: [
        {
          name: "instanceId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Ratings for this caller on this instance",
          content: {
            "application/json": {
              schema: resolver(FeedbackListResponse),
            },
          },
        },
        404: {
          description:
            "Instance not found, or caller is not a principal of its tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: "Stored ratings failed schema validation",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const instanceId = c.req.param("instanceId");

      const caller = await resolveInstanceOwner(db, instanceId, userId);
      if (!caller) {
        return c.json({ error: "Instance not found" }, 404);
      }

      const rows = await db
        .select({
          subjectId: outputFeedback.subjectId,
          subjectKind: outputFeedback.subjectKind,
          rating: outputFeedback.rating,
        })
        .from(outputFeedback)
        .where(
          and(
            eq(outputFeedback.principalId, caller.principalId),
            eq(outputFeedback.instanceId, instanceId),
          ),
        );

      const response = FeedbackListResponse({ ratings: rows });
      if (response instanceof type.errors) {
        log.error(
          "Stored feedback rows failed schema validation for instance {instanceId}: {error}",
          {
            instanceId,
            error: response.summary,
          },
        );
        return c.json({ error: response.summary }, 500);
      }
      return c.json(response);
    },
  );

  return app;
}
