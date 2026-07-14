import { type } from "arktype";
import { Hono, type Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { streamSSE } from "hono/streaming";
import { getLogger } from "@intx/log";
import { MailboxListResponse, MailboxMessageDetail } from "@workbench/shared";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import {
  getMailboxMessage,
  listUserMailbox,
  markMailboxMessageRead,
} from "../lib/mailbox-read";
import {
  applyMailboxBulkAction,
  archiveMailboxMessage,
  countUnreadActiveMailbox,
  markMailboxMessageUnread,
  restoreMailboxMessage,
  trashMailboxMessage,
} from "../lib/mailbox-mutations";
import {
  MailboxBulkRequest,
  MailboxBulkResponse,
  MailboxInboxView,
  MailboxUnreadCountResponse,
} from "../lib/mailbox-inbox-view";
import type { MailboxEventBus } from "../lib/mailbox-events";
import { UuidParam } from "../lib/uuid";
import { ErrorResponse } from "../lib/openapi";
import { clampLimit, decodeCursor, MAX_PAGE_LIMIT } from "../lib/keyset";
import type { HubDb } from "../db";

const log = getLogger(["api", "inbox"]);

const MarkReadResponse = type({ id: "string", read: "boolean" });
const DEFAULT_INBOX_LIMIT = 50;

function publishMailboxSignal(
  bus: MailboxEventBus,
  principalId: string,
  id: string,
): void {
  bus.publish(principalId, { type: "mailbox", id });
}

const HEARTBEAT_INTERVAL_MS = 25_000;

// The signed-in user's durable mailbox: mail addressed to their usr_
// address, persisted to principal_mailbox by the sidecar persistMail
// override. Scoped strictly to the caller's own member principal.
export function createInboxRouter(
  db: HubDb,
  bus: MailboxEventBus,
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
          schema: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
          description: `Maximum messages to return (default ${DEFAULT_INBOX_LIMIT}, clamped to ${MAX_PAGE_LIMIT})`,
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Opaque keyset cursor from a previous page's nextCursor; omit for the first page",
        },
        {
          name: "view",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["all", "unread", "archived", "trash"],
          },
          description:
            "Inbox folder view (default all — active messages excluding archive and trash)",
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
      const limit = clampLimit(c.req.query("limit"), {
        default: DEFAULT_INBOX_LIMIT,
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
      const rawView = c.req.query("view");
      const view =
        rawView === undefined ? ("all" as const) : MailboxInboxView(rawView);
      if (view instanceof type.errors) {
        return c.json({ error: "invalid inbox view" }, 400);
      }
      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      const page = await listUserMailbox(db, {
        tenantId: member.tenantId,
        principalId: member.principalId,
        limit,
        view,
        ...(cursor ? { cursor } : {}),
      });
      return c.json({
        messages: page.items,
        ...(page.nextCursor !== undefined
          ? { nextCursor: page.nextCursor }
          : {}),
      });
    },
  );

  app.get(
    "/me/inbox/events",
    describeRoute({
      tags: ["Me"],
      summary: "Stream a live signal when a new mailbox message is delivered",
      description:
        "Server-Sent Events stream of minimal delivery signals ({type:'mailbox', id}) for the caller's own mailbox — never mail content; the client reacts by refetching GET /me/inbox. BetterAuth-authenticated; identity is derived from the session, never a path parameter.",
      responses: {
        200: {
          description: "Server-Sent Events stream of mailbox delivery signals",
          content: { "text/event-stream": {} },
        },
        409: {
          description: "Caller has no provisioned membership yet",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      const { principalId } = member;

      return streamSSE(c, async (stream) => {
        const unsubscribe = bus.subscribe(principalId, (event) => {
          void stream.writeSSE({
            event: "mailbox",
            data: JSON.stringify(event),
          });
        });

        stream.onAbort(() => unsubscribe());

        try {
          while (!stream.aborted) {
            await stream.sleep(HEARTBEAT_INTERVAL_MS);
            if (stream.aborted) break;
            await stream.write(": heartbeat\n\n");
          }
        } catch (err) {
          log.warn("mailbox stream ended", {
            principalId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          unsubscribe();
        }
      });
    },
  );

  app.get(
    "/me/inbox/unread-count",
    describeRoute({
      tags: ["Me"],
      summary: "Count unread messages in the caller's active inbox",
      responses: {
        200: {
          description: "Unread count excluding archived and trashed rows",
          content: {
            "application/json": {
              schema: resolver(MailboxUnreadCountResponse),
            },
          },
        },
        409: {
          description: "Caller has no provisioned membership yet",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      const unread = await countUnreadActiveMailbox(db, {
        tenantId: member.tenantId,
        principalId: member.principalId,
      });
      return c.json({ unread });
    },
  );

  app.get(
    "/me/inbox/:id",
    describeRoute({
      tags: ["Me"],
      summary: "Read one of the caller's mailbox messages with its full body",
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
          description: "The message with its full text body",
          content: {
            "application/json": { schema: resolver(MailboxMessageDetail) },
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
      const id = UuidParam(c.req.param("id"));
      if (id instanceof type.errors) {
        return c.json({ error: "Message id must be a UUID" }, 400);
      }
      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      const message = await getMailboxMessage(db, {
        tenantId: member.tenantId,
        principalId: member.principalId,
        id,
      });
      if (!message) {
        return c.json({ error: "Message not found" }, 404);
      }
      return c.json(message);
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
      const id = UuidParam(c.req.param("id"));
      if (id instanceof type.errors) {
        return c.json({ error: "Message id must be a UUID" }, 400);
      }
      const member = await resolveCallerMember(db, userId);
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
      publishMailboxSignal(bus, member.principalId, id);
      return c.json({ id, read: true });
    },
  );

  app.post(
    "/me/inbox/bulk",
    describeRoute({
      tags: ["Me"],
      summary: "Apply a bulk inbox action to multiple mailbox messages",
      responses: {
        200: {
          description: "Bulk action result",
          content: {
            "application/json": { schema: resolver(MailboxBulkResponse) },
          },
        },
        400: {
          description: "Invalid request body",
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
      const body = MailboxBulkRequest(await c.req.json());
      if (body instanceof type.errors) {
        return c.json({ error: "invalid bulk inbox request" }, 400);
      }
      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      const updatedIds = await applyMailboxBulkAction(
        db,
        { tenantId: member.tenantId, principalId: member.principalId },
        body.action,
        body.ids,
      );
      for (const updatedId of updatedIds) {
        publishMailboxSignal(bus, member.principalId, updatedId);
      }
      return c.json({ updated: updatedIds.length, ids: updatedIds });
    },
  );

  async function singleMessageMutation(
    c: Context<{ Variables: { userId: string } }>,
    idParam: string,
    run: (scope: {
      tenantId: string;
      principalId: string;
      id: string;
    }) => Promise<boolean>,
  ) {
    const userId = c.get("userId");
    const id = UuidParam(idParam);
    if (id instanceof type.errors) {
      return c.json({ error: "Message id must be a UUID" }, 400);
    }
    const member = await resolveCallerMember(db, userId);
    if (!member) {
      return c.json({ error: "No provisioned membership" }, 409);
    }
    const ok = await run({
      tenantId: member.tenantId,
      principalId: member.principalId,
      id,
    });
    if (!ok) return c.json({ error: "Message not found" }, 404);
    publishMailboxSignal(bus, member.principalId, id);
    return c.json({ id, ok: true as const });
  }

  app.post("/me/inbox/:id/unread", async (c) => {
    const id = c.req.param("id");
    return singleMessageMutation(c, id, (scope) =>
      markMailboxMessageUnread(db, scope),
    );
  });

  app.post("/me/inbox/:id/trash", async (c) => {
    const id = c.req.param("id");
    return singleMessageMutation(c, id, (scope) =>
      trashMailboxMessage(db, scope),
    );
  });

  app.post("/me/inbox/:id/archive", async (c) => {
    const id = c.req.param("id");
    return singleMessageMutation(c, id, (scope) =>
      archiveMailboxMessage(db, scope),
    );
  });

  app.post("/me/inbox/:id/restore", async (c) => {
    const id = c.req.param("id");
    return singleMessageMutation(c, id, (scope) =>
      restoreMailboxMessage(db, scope),
    );
  });

  return app;
}
