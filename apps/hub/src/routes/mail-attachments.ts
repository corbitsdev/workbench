import { eq } from "drizzle-orm";
import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import {
  SaveMailAttachmentRefsRequest,
  MailAttachmentRefsResponse,
} from "@workbench/shared";
import { mailAttachmentRef } from "../db/schema";
import type { HubDb } from "../db";
import { resolveInstanceOwner } from "../lib/instance-ownership";
import { requestBodySchema } from "../lib/openapi";

const log = getLogger(["hub", "mail-attachments"]);

const ErrorResponse = type({ error: "string" });

/**
 * Workbench-owned persistence for chat attachment chips. Uploads never ride
 * inline on mail (interchange forwards mail attachments straight to the model:
 * images as inline base64, documents as content blocks the openai adapter
 * rejects), so the web client diverts every file through the parse route and
 * records a reference here — mail id to file artifact — that the transcript
 * rehydrates from after reload.
 */
export function createMailAttachmentsRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.post(
    "/instances/:instanceId/mail-attachments",
    describeRoute({
      tags: ["Instances"],
      summary: "Persist attachment references for a sent chat message",
      description:
        "Records which file artifacts were attached to a mail message so the transcript can rehydrate attachment chips after reload. The files themselves are stored as artifacts by the parse-file route; nothing here reaches the model.",
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
          "application/json": {
            schema: requestBodySchema(SaveMailAttachmentRefsRequest),
          },
        },
      },
      responses: {
        201: { description: "References recorded" },
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
      const body = SaveMailAttachmentRefsRequest(raw);
      if (body instanceof type.errors) {
        return c.json({ error: body.summary }, 400);
      }

      const caller = await resolveInstanceOwner(db, instanceId, userId);
      if (!caller) {
        return c.json({ error: "Instance not found" }, 404);
      }

      await db
        .insert(mailAttachmentRef)
        .values(
          body.attachments.map((a) => ({
            tenantId: caller.tenantId,
            principalId: caller.principalId,
            instanceId,
            mailId: body.mailId,
            artifactId: a.artifactId,
            name: a.name,
            mimeType: a.type,
            size: a.size,
          })),
        )
        .onConflictDoNothing();

      log.info("Persisted mail attachment refs", {
        instanceId,
        mailId: body.mailId,
        count: body.attachments.length,
      });

      return c.json({}, 201);
    },
  );

  app.get(
    "/instances/:instanceId/mail-attachments",
    describeRoute({
      tags: ["Instances"],
      summary: "List persisted attachment references for an instance",
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
          description: "All attachment references for this instance",
          content: {
            "application/json": {
              schema: resolver(MailAttachmentRefsResponse),
            },
          },
        },
        404: {
          description:
            "Instance not found, or caller is not a principal of its tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: "Stored references failed schema validation",
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
          mailId: mailAttachmentRef.mailId,
          artifactId: mailAttachmentRef.artifactId,
          name: mailAttachmentRef.name,
          type: mailAttachmentRef.mimeType,
          size: mailAttachmentRef.size,
        })
        .from(mailAttachmentRef)
        .where(eq(mailAttachmentRef.instanceId, instanceId));

      const response = MailAttachmentRefsResponse({ refs: rows });
      if (response instanceof type.errors) {
        log.error(
          "Stored mail attachment refs failed schema validation for instance {instanceId}: {error}",
          { instanceId, error: response.summary },
        );
        return c.json({ error: response.summary }, 500);
      }
      return c.json(response);
    },
  );

  return app;
}
