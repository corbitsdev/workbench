import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import {
  CreateTaskBodySchema,
  PushTaskBodySchema,
  PushTaskResponseSchema,
  TaskListResponseSchema,
  TaskSchema,
  UpdateTaskBodySchema,
} from "@workbench/shared";
import { createTaskPushService, TASK_ADAPTERS } from "@workbench/tasks";
import { resolveCallerMember } from "../lib/tenant-provisioning";
import { resolveAdapterCredential } from "../lib/task-credential";
import { getIdentityAccounts } from "../lib/member-identity";
import {
  createOwnerTask,
  getOwnerTask,
  listOwnerTasks,
  updateOwnerTask,
} from "../lib/task-store";
import { createDrizzleTaskPushStore } from "../lib/task-push-store";
import { requestBodySchema } from "../lib/openapi";
import { UuidParam } from "../lib/uuid";
import type { HubDb } from "../db";

const ErrorResponse = type({ error: "string" });

// Owner-scoped CRUD over the caller's native tasks plus a downstream push. Every
// read and write is bound to the caller's own member principal, so a member can
// never see or mutate another member's task (CL-3315).
export function createMeTasksRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.get(
    "/me/tasks",
    describeRoute({
      tags: ["Me"],
      summary: "List the caller's tasks",
      responses: {
        200: {
          description: "The caller's tasks (empty when none/no membership)",
          content: {
            "application/json": { schema: resolver(TaskListResponseSchema) },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const member = await resolveCallerMember(db, userId);
      if (!member) return c.json([]);
      const tasks = await listOwnerTasks(db, {
        tenantId: member.tenantId,
        ownerPrincipalId: member.principalId,
      });
      return c.json(tasks);
    },
  );

  app.post(
    "/me/tasks",
    describeRoute({
      tags: ["Me"],
      summary: "Create a task owned by the caller",
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(CreateTaskBodySchema),
          },
        },
      },
      responses: {
        201: {
          description: "The created task",
          content: { "application/json": { schema: resolver(TaskSchema) } },
        },
        400: {
          description: "Invalid body",
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
      const body = CreateTaskBodySchema(raw);
      if (body instanceof type.errors) {
        return c.json({ error: body.summary }, 400);
      }
      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      const created = await createOwnerTask(db, {
        tenantId: member.tenantId,
        ownerPrincipalId: member.principalId,
        createdByPrincipalId: member.principalId,
        title: body.title,
        source: "user",
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.due !== undefined ? { due: body.due } : {}),
        ...(body.links !== undefined ? { links: body.links } : {}),
      });
      return c.json(created, 201);
    },
  );

  app.patch(
    "/me/tasks/:id",
    describeRoute({
      tags: ["Me"],
      summary: "Update the caller's task",
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(UpdateTaskBodySchema),
          },
        },
      },
      responses: {
        200: {
          description: "The updated task",
          content: { "application/json": { schema: resolver(TaskSchema) } },
        },
        400: {
          description: "Invalid id, body, or empty patch",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No such task owned by the caller",
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
        return c.json({ error: "Task id must be a UUID" }, 400);
      }
      const raw = await c.req.json().catch(() => null);
      const body = UpdateTaskBodySchema(raw);
      if (body instanceof type.errors) {
        return c.json({ error: body.summary }, 400);
      }
      if (
        body.title === undefined &&
        body.body === undefined &&
        body.status === undefined &&
        body.due === undefined
      ) {
        return c.json({ error: "no fields to update" }, 400);
      }
      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      const updated = await updateOwnerTask(db, {
        tenantId: member.tenantId,
        ownerPrincipalId: member.principalId,
        id,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.due !== undefined ? { due: body.due } : {}),
      });
      if (!updated) return c.json({ error: "task not found" }, 404);
      return c.json(updated);
    },
  );

  app.post(
    "/me/tasks/:id/push",
    describeRoute({
      tags: ["Me"],
      // The session-authed human's click on this endpoint IS the approval for
      // the downstream write — no separate approval gate is consulted for a
      // user-initiated push (agent-initiated pushes are governed elsewhere).
      summary:
        "Push the caller's task to a downstream adapter (the call is the approval)",
      requestBody: {
        content: {
          "application/json": { schema: requestBodySchema(PushTaskBodySchema) },
        },
      },
      responses: {
        200: {
          description: "The push outcome (linked or still sending)",
          content: {
            "application/json": { schema: resolver(PushTaskResponseSchema) },
          },
        },
        400: {
          description: "Invalid id, body, or unknown adapter",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No such task owned by the caller",
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
        return c.json({ error: "Task id must be a UUID" }, 400);
      }
      const raw = await c.req.json().catch(() => null);
      const body = PushTaskBodySchema(raw);
      if (body instanceof type.errors) {
        return c.json({ error: body.summary }, 400);
      }
      if (TASK_ADAPTERS[body.adapterId] === undefined) {
        return c.json({ error: `unknown adapter "${body.adapterId}"` }, 400);
      }
      const member = await resolveCallerMember(db, userId);
      if (!member) {
        return c.json({ error: "No provisioned membership" }, 409);
      }
      // Ownership check: the push service loads the task by id alone, so gate
      // here on the caller owning it before any external write.
      const owned = await getOwnerTask(db, {
        tenantId: member.tenantId,
        ownerPrincipalId: member.principalId,
        id,
      });
      if (!owned) return c.json({ error: "task not found" }, 404);

      const pushService = createTaskPushService({
        store: createDrizzleTaskPushStore(db),
        adapters: TASK_ADAPTERS,
        resolveCredential: resolveAdapterCredential(db),
        resolveAssignee: async (ownerPrincipalId, _adapterId) => {
          const provider = TASK_ADAPTERS[body.adapterId]?.providerName;
          if (provider === undefined) return null;
          const accounts = await getIdentityAccounts(
            db,
            member.tenantId,
            ownerPrincipalId,
            [provider],
          );
          return accounts[0]?.value ?? null;
        },
      });

      const outcome = await pushService.pushTask({
        taskId: id,
        adapterId: body.adapterId,
        operation: body.operation ?? "create",
        actorPrincipalId: member.principalId,
      });
      return c.json(outcome);
    },
  );

  return app;
}
