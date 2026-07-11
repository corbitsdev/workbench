import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { MailboxListResponse } from "@workbench/shared";
import { lookupMember, getRootTenantId } from "../lib/tenant-provisioning";
import { listUserMailbox, markMailboxMessageRead } from "../lib/mailbox-read";
import type { HubDb } from "../db";

const ErrorResponse = type({ error: "string" });
const MarkReadResponse = type({ id: "string", read: "boolean" });
const MessageId = type("string.uuid");

const DEFAULT_INBOX_LIMIT = 50;
const MAX_INBOX_LIMIT = 200;

function parseLimit(rawLimit: string | undefined): number | null {
  if (rawLimit === undefined) return DEFAULT_INBOX_LIMIT;
  const parsed = Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_INBOX_LIMIT) {
    return null;
  }
  return parsed;
}

// The signed-in user's durable mailbox: mail addressed to their usr_
// address, persisted to principal_mailbox by the sidecar persistMail
// override. Scoped strictly to the caller's own member principal.
export function createInboxRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.get(
    "/me/inbox",
    describeRoute({
      tags: ["Me"],
      summary: "List the caller's received mailbox messages",
      parameters: [
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: MAX_INBOX_LIMIT },
          description: `Maximum messages to return (default ${DEFAULT_INBOX_LIMIT})`,
        },
      ],
      responses: {
        200: {
          description: "The caller's messages, newest first",
          content: {
            "application/json": { schema: resolver(MailboxListResponse) },
          },
        },
        400: {
          description: "Invalid limit",
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
      const limit = parseLimit(c.req.query("limit"));
      if (limit === null) {
        return c.json({ error: "limit must be an integer between 1 and 200" }, 400);
      }
      const rootTenantId = await getRootTenantId(db);
      const member = rootTenantId
        ? await lookupMember(db, { tenantId: rootTenantId, userId })
        : null;
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      const messages = await listUserMailbox(db, {
        tenantId: member.tenantId,
        principalId: member.principalId,
        limit,
      });
      return c.json({ messages });
    },
  );

  app.post(
    "/me/inbox/:id/read",
    describeRoute({
      tags: ["Me"],
      summary: "Mark one of the caller's mailbox messages as read",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        200: {
          description: "The message is now read",
          content: {
            "application/json": { schema: resolver(MarkReadResponse) },
          },
        },
        400: {
          description: "Invalid message id",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No such message in the caller's mailbox",
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
      const id = MessageId(c.req.param("id"));
      if (id instanceof type.errors) {
        return c.json({ error: "Message id must be a UUID" }, 400);
      }
      const rootTenantId = await getRootTenantId(db);
      const member = rootTenantId
        ? await lookupMember(db, { tenantId: rootTenantId, userId })
        : null;
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      const marked = await markMailboxMessageRead(db, {
        tenantId: member.tenantId,
        principalId: member.principalId,
        id,
      });
      if (!marked) {
        return c.json({ error: "Message not found" }, 404);
      }
      return c.json({ id, read: true });
    },
  );

  return app;
}
