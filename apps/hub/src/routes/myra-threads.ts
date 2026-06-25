import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { type } from "arktype";
import type { DB } from "@intx/db";
import type {
  SessionService,
  EventCollectorRegistry,
} from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";
import { requestBodySchema } from "../lib/openapi";
import type { HubDb } from "../db";
import {
  createMyraThread,
  deleteMyraThread,
  generateMyraThreadTitle,
  listMyraThreads,
  MyraThreadLaunchError,
  renameMyraThread,
  resolveMyraThreadContext,
} from "../services/myra-threads";

const MyraThread = type({
  id: "string",
  instanceId: "string",
  label: "string",
  createdAt: "string",
});

const MyraThreadList = type({ threads: MyraThread.array() });

const CreateMyraThreadBody = type({
  label: "string?",
});

const RenameMyraThreadBody = type({
  label: "string",
});

const TitleMyraThreadBody = type({
  firstMessage: "string > 0",
});

export function createMyraThreadsRouter(
  db: DB["db"],
  sessionService: SessionService,
  grantStore: GrantStore,
  eventCollectors: EventCollectorRegistry,
) {
  const app = new Hono<{ Variables: { userId: string } }>();
  const hubDb = db as unknown as HubDb;

  app.get(
    "/me/myra/threads",
    describeRoute({
      tags: ["Agents"],
      summary: "List Myra chat threads for the current member",
      responses: {
        200: {
          description: "Thread list",
          content: { "application/json": { schema: resolver(MyraThreadList) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const ctx = await resolveMyraThreadContext(hubDb, userId);
      if (!ctx) {
        return c.json({ error: "Member not provisioned" }, 503);
      }
      const threads = await listMyraThreads(hubDb, {
        tenantId: ctx.tenantId,
        memberPrincipalId: ctx.memberPrincipalId,
      });
      return c.json({ threads });
    },
  );

  app.post(
    "/me/myra/threads",
    describeRoute({
      tags: ["Agents"],
      summary: "Create a new Myra chat thread (new agent instance + session)",
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(CreateMyraThreadBody),
          },
        },
      },
      responses: {
        201: {
          description: "Thread created",
          content: {
            "application/json": {
              schema: resolver(type({ thread: MyraThread, created: "true" })),
            },
          },
        },
        503: {
          description:
            "Member not provisioned, or the chat session failed to launch",
          content: {
            "application/json": {
              schema: resolver(
                type({
                  error: "string",
                  "phase?": "string | null",
                  "detail?": "string",
                  "leakedAgent?": "boolean",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const body = CreateMyraThreadBody.assert(
        await c.req.json().catch(() => ({})),
      );
      const ctx = await resolveMyraThreadContext(hubDb, userId);
      if (!ctx) {
        return c.json({ error: "Member not provisioned" }, 503);
      }
      try {
        const result = await createMyraThread(
          hubDb,
          { sessionService, grantStore, eventCollectors },
          {
            tenantId: ctx.tenantId,
            tenantDomain: ctx.tenantDomain,
            memberPrincipalId: ctx.memberPrincipalId,
            ...(body.label !== undefined ? { label: body.label } : {}),
          },
        );
        return c.json(result, 201);
      } catch (err) {
        if (err instanceof MyraThreadLaunchError) {
          return c.json(
            {
              error: "Failed to launch Myra chat session",
              phase: err.phase,
              detail: err.detail,
              leakedAgent: err.leakedAgent,
            },
            503,
          );
        }
        throw err;
      }
    },
  );

  app.patch(
    "/me/myra/threads/:id",
    describeRoute({
      tags: ["Agents"],
      summary: "Rename a Myra chat thread",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(RenameMyraThreadBody),
          },
        },
      },
      responses: {
        200: {
          description: "Thread renamed",
          content: {
            "application/json": {
              schema: resolver(type({ thread: MyraThread })),
            },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const threadId = c.req.param("id");
      const parsed = RenameMyraThreadBody(await c.req.json().catch(() => ({})));
      if (parsed instanceof type.errors) {
        return c.json({ error: "label is required" }, 400);
      }
      const label = parsed.label.trim();
      if (!label) {
        return c.json({ error: "label is required" }, 400);
      }
      const ctx = await resolveMyraThreadContext(hubDb, userId);
      if (!ctx) {
        return c.json({ error: "Member not provisioned" }, 503);
      }
      const thread = await renameMyraThread(hubDb, {
        tenantId: ctx.tenantId,
        memberPrincipalId: ctx.memberPrincipalId,
        threadId,
        label,
      });
      if (!thread) {
        return c.json({ error: "Thread not found" }, 404);
      }
      return c.json({ thread });
    },
  );

  app.post(
    "/me/myra/threads/:id/title",
    describeRoute({
      tags: ["Agents"],
      summary: "Auto-title a Myra chat thread from its first user message",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(TitleMyraThreadBody),
          },
        },
      },
      responses: {
        200: {
          description:
            "Thread titled, or no-op (thread null) when titling was skipped or failed",
          content: {
            "application/json": {
              schema: resolver(type({ thread: MyraThread.or("null") })),
            },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const threadId = c.req.param("id");
      const parsed = TitleMyraThreadBody(await c.req.json().catch(() => ({})));
      if (parsed instanceof type.errors) {
        return c.json({ error: "firstMessage is required" }, 400);
      }
      const ctx = await resolveMyraThreadContext(hubDb, userId);
      if (!ctx) {
        return c.json({ error: "Member not provisioned" }, 503);
      }
      const thread = await generateMyraThreadTitle(
        hubDb,
        {},
        {
          tenantId: ctx.tenantId,
          memberPrincipalId: ctx.memberPrincipalId,
          threadId,
          firstMessage: parsed.firstMessage,
        },
      );
      return c.json({ thread });
    },
  );

  app.delete(
    "/me/myra/threads/:id",
    describeRoute({
      tags: ["Agents"],
      summary: "Delete a Myra chat thread (tears down the agent instance)",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        200: {
          description: "Thread deleted",
          content: {
            "application/json": { schema: resolver(type({ deleted: "true" })) },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const threadId = c.req.param("id");
      const ctx = await resolveMyraThreadContext(hubDb, userId);
      if (!ctx) {
        return c.json({ error: "Member not provisioned" }, 503);
      }
      const deleted = await deleteMyraThread(
        hubDb,
        { sessionService },
        {
          tenantId: ctx.tenantId,
          memberPrincipalId: ctx.memberPrincipalId,
          threadId,
        },
      );
      if (!deleted) {
        return c.json({ error: "Thread not found" }, 404);
      }
      return c.json({ deleted: true });
    },
  );

  return app;
}
