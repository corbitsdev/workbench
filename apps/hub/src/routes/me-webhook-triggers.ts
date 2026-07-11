import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import {
  CreateWebhookTriggerBodySchema,
  CreateWebhookTriggerResponseSchema,
  WebhookTriggerListResponseSchema,
} from "@workbench/shared";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import { isRunnableKind } from "../lib/workflow-run-gate";
import { isUuid } from "../lib/uuid";
import {
  createOwnerWebhookTrigger,
  deleteOwnerWebhookTrigger,
  listOwnerWebhookTriggers,
  toApiWebhookTrigger,
} from "../lib/webhook-triggers";
import { ErrorResponse, requestBodySchema } from "../lib/openapi";
import { clampLimit, decodeCursor, MAX_PAGE_LIMIT } from "../lib/keyset";
import type { HubDb } from "../db";

const DEFAULT_WEBHOOK_TRIGGERS_PAGE_LIMIT = 50;

// Owner-scoped CRUD over the caller's webhook triggers. Every read
// and write is scoped to the caller's own member principal, so a member can
// never see or mutate another member's trigger. Mirrors /me/schedules.
export function createMeWebhookTriggersRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.get(
    "/me/webhook-triggers",
    describeRoute({
      tags: ["Me"],
      summary: "List the caller's webhook triggers (never returns the secret)",
      parameters: [
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
          description: `Maximum triggers to return (default ${DEFAULT_WEBHOOK_TRIGGERS_PAGE_LIMIT}, clamped to ${MAX_PAGE_LIMIT})`,
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Opaque keyset cursor from a previous page's nextCursor; omit for the first page",
        },
      ],
      responses: {
        200: {
          description:
            "One page of the caller's triggers (empty when none/no membership)",
          content: {
            "application/json": {
              schema: resolver(WebhookTriggerListResponseSchema),
            },
          },
        },
        400: {
          description: "Invalid limit or cursor",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const limit = clampLimit(c.req.query("limit"), {
        default: DEFAULT_WEBHOOK_TRIGGERS_PAGE_LIMIT,
      });
      if (limit === null) {
        return c.json({ error: "limit must be a positive integer" }, 400);
      }
      const rawCursor = c.req.query("cursor");
      const cursor =
        rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (rawCursor !== undefined && cursor === null) {
        return c.json({ error: "malformed cursor" }, 400);
      }
      const member = await resolveCallerMember(db, userId);
      if (!member) return c.json({ items: [] });
      const page = await listOwnerWebhookTriggers(
        db,
        member.tenantId,
        member.principalId,
        { limit, ...(cursor ? { cursor } : {}) },
      );
      return c.json({
        items: page.items.map(toApiWebhookTrigger),
        ...(page.nextCursor !== undefined
          ? { nextCursor: page.nextCursor }
          : {}),
      });
    },
  );

  app.post(
    "/me/webhook-triggers",
    describeRoute({
      tags: ["Me"],
      summary:
        "Create a webhook trigger for the caller; the plaintext secret is returned once",
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(CreateWebhookTriggerBodySchema),
          },
        },
      },
      responses: {
        201: {
          description: "The created trigger, including its plaintext secret",
          content: {
            "application/json": {
              schema: resolver(CreateWebhookTriggerResponseSchema),
            },
          },
        },
        400: {
          description: "Invalid body or unknown workflow kind",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        409: {
          description: "Caller has no provisioned membership yet",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const raw = await c.req.json().catch(() => null);
      const body = CreateWebhookTriggerBodySchema(raw);
      if (body instanceof type.errors) {
        return c.json({ error: body.summary }, 400);
      }

      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }

      if (!(await isRunnableKind(db, member.tenantId, body.kind))) {
        return c.json({ error: `unknown workflow kind "${body.kind}"` }, 400);
      }

      const { row, secret } = await createOwnerWebhookTrigger(db, {
        tenantId: member.tenantId,
        ownerPrincipalId: member.principalId,
        kind: body.kind,
      });
      return c.json({ ...toApiWebhookTrigger(row), secret }, 201);
    },
  );

  app.delete(
    "/me/webhook-triggers/:id",
    describeRoute({
      tags: ["Me"],
      summary: "Delete the caller's webhook trigger",
      responses: {
        204: { description: "Deleted" },
        400: {
          description: "Malformed trigger id",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No such trigger owned by the caller",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        409: {
          description: "Caller has no provisioned membership yet",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const id = c.req.param("id");
      if (!isUuid(id)) {
        return c.json({ error: "malformed trigger id" }, 400);
      }

      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }

      const deleted = await deleteOwnerWebhookTrigger(db, {
        tenantId: member.tenantId,
        ownerPrincipalId: member.principalId,
        id,
      });
      if (!deleted) return c.json({ error: "trigger not found" }, 404);
      return c.body(null, 204);
    },
  );

  return app;
}
