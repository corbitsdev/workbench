import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { type } from "arktype";
import type { DB } from "@intx/db";
import type {
  SessionService,
  EventCollectorRegistry,
  SidecarRouter,
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
  relaunchMyraThread,
  renameMyraThread,
  resolveMyraThreadContext,
} from "../services/myra-threads";

const MyraThread = type({
  id: "string",
  instanceId: "string",
  label: "string",
  createdAt: "string",
});

// The list carries a per-thread `updateAvailable` flag; the create/rename/title
// responses do not (they describe a single just-mutated thread). (CL-2518)
const MyraThreadListItem = type({
  id: "string",
  instanceId: "string",
  label: "string",
  createdAt: "string",
  updateAvailable: "boolean",
});

const MyraThreadList = type({ threads: MyraThreadListItem.array() });

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
  sidecarRouter: SidecarRouter,
) {
  const app = new Hono<{ Variables: { userId: string } }>();
  const hubDb = db as unknown as HubDb;

  app.get(
    "/tenants/:tenantId/me/myra/threads",
    describeRoute({
      tags: ["Agents"],
      summary: "List Myra chat threads for the current member in a workbench",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Thread list",
          content: { "application/json": { schema: resolver(MyraThreadList) } },
        },
        403: { description: "Not a member of this tenant" },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const tenantId = c.req.param("tenantId");
      const ctx = await resolveMyraThreadContext(hubDb, userId, tenantId);
      if (!ctx) {
        return c.json({ error: "Not a member of this tenant" }, 403);
      }
      const threads = await listMyraThreads(hubDb, {
        tenantId: ctx.tenantId,
        memberPrincipalId: ctx.memberPrincipalId,
      });
      return c.json({ threads });
    },
  );

  app.post(
    "/tenants/:tenantId/me/myra/threads",
    describeRoute({
      tags: ["Agents"],
      summary: "Create a new Myra chat thread (new agent instance + session)",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
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
        403: { description: "Not a member of this tenant" },
        503: {
          description: "The chat session failed to launch",
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
      const tenantId = c.req.param("tenantId");
      const body = CreateMyraThreadBody.assert(
        await c.req.json().catch(() => ({})),
      );
      const ctx = await resolveMyraThreadContext(hubDb, userId, tenantId);
      if (!ctx) {
        return c.json({ error: "Not a member of this tenant" }, 403);
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
    "/tenants/:tenantId/me/myra/threads/:id",
    describeRoute({
      tags: ["Agents"],
      summary: "Rename a Myra chat thread",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
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
      const tenantId = c.req.param("tenantId");
      const threadId = c.req.param("id");
      const parsed = RenameMyraThreadBody(await c.req.json().catch(() => ({})));
      if (parsed instanceof type.errors) {
        return c.json({ error: "label is required" }, 400);
      }
      const label = parsed.label.trim();
      if (!label) {
        return c.json({ error: "label is required" }, 400);
      }
      const ctx = await resolveMyraThreadContext(hubDb, userId, tenantId);
      if (!ctx) {
        return c.json({ error: "Not a member of this tenant" }, 403);
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
    "/tenants/:tenantId/me/myra/threads/:id/title",
    describeRoute({
      tags: ["Agents"],
      summary: "Auto-title a Myra chat thread from its first user message",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
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
      const tenantId = c.req.param("tenantId");
      const threadId = c.req.param("id");
      const parsed = TitleMyraThreadBody(await c.req.json().catch(() => ({})));
      if (parsed instanceof type.errors) {
        return c.json({ error: "firstMessage is required" }, 400);
      }
      const ctx = await resolveMyraThreadContext(hubDb, userId, tenantId);
      if (!ctx) {
        return c.json({ error: "Not a member of this tenant" }, 403);
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

  app.post(
    "/tenants/:tenantId/me/myra/threads/:id/relaunch",
    describeRoute({
      tags: ["Agents"],
      summary:
        "Update Myra for one thread: reseed the tenant def if stale and relaunch this thread's session against it so the latest tools load",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        200: {
          description:
            "Relaunch attempted. `applied` is false when the live session could not be torn down in time — the thread is unchanged and the member can retry.",
          content: {
            "application/json": {
              schema: resolver(
                type({ thread: MyraThread, applied: "boolean" }),
              ),
            },
          },
        },
        403: { description: "Not a member of this tenant" },
        404: { description: "Thread not found" },
        503: {
          description: "The chat session failed to relaunch",
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
      const tenantId = c.req.param("tenantId");
      const threadId = c.req.param("id");
      const ctx = await resolveMyraThreadContext(hubDb, userId, tenantId);
      if (!ctx) {
        return c.json({ error: "Not a member of this tenant" }, 403);
      }
      try {
        const result = await relaunchMyraThread(
          hubDb,
          { sessionService, grantStore, eventCollectors, sidecarRouter },
          {
            tenantId: ctx.tenantId,
            tenantDomain: ctx.tenantDomain,
            memberPrincipalId: ctx.memberPrincipalId,
            threadId,
          },
        );
        if (!result) {
          return c.json({ error: "Thread not found" }, 404);
        }
        return c.json({ thread: result.thread, applied: result.applied });
      } catch (err) {
        if (err instanceof MyraThreadLaunchError) {
          return c.json(
            {
              error: "Failed to relaunch Myra chat session",
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

  app.delete(
    "/tenants/:tenantId/me/myra/threads/:id",
    describeRoute({
      tags: ["Agents"],
      summary: "Delete a Myra chat thread (tears down the agent instance)",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
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
      const tenantId = c.req.param("tenantId");
      const threadId = c.req.param("id");
      const ctx = await resolveMyraThreadContext(hubDb, userId, tenantId);
      if (!ctx) {
        return c.json({ error: "Not a member of this tenant" }, 403);
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
