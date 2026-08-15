// The HTTP surface of `@corbits/tasks`: create, list, get. Mounted by
// the host inside its tenant-scoped middleware (`TenantEnv`'s
// `tenant`/`principal` are always resolved before a handler here
// runs), mirroring `@corbits/chat`'s `createChatRoutes` — grant checks
// via `requireGrant`, request parsing via arktype at the boundary,
// route registration only, no business logic (that lives in
// `./launcher.ts`).
import { type } from "arktype";
import { Hono } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import type { RequireGrant } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";

import {
  TaskDefinitionNotFoundError,
  TaskDefinitionNotLaunchableError,
  TaskDefinitionNotTaskableError,
  type LaunchTaskInput,
} from "./launcher";
import type { TaskRecord, TaskStore } from "./store";

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const CreateTaskBody = type({
  definitionId: "string > 0",
  prompt: "string > 0",
  "modelPreference?": "string > 0",
});

function taskView(record: TaskRecord) {
  return {
    id: record.id,
    definitionId: record.definitionId,
    prompt: record.prompt,
    modelPreference: record.modelPreference,
    status: record.status,
    runId: record.runId,
    resultMailId: record.resultMailId,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
  };
}

export type CreateTaskRoutesDeps = {
  store: TaskStore;
  requireGrant: RequireGrant;
  /**
   * The launch port, mirroring `@corbits/chat`'s routes-depend-on-
   * platform-port shape: routes never call `launchFoldedRun` (or
   * anything else in `./launcher.ts`) directly, so this module is
   * testable with a plain stub — no database, no sidecar router.
   */
  launch: (input: LaunchTaskInput) => Promise<TaskRecord>;
};

export function createTaskRoutes(deps: CreateTaskRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.post("/", deps.requireGrant("task:*", "create"), async (c) => {
    const body = CreateTaskBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid task body: ${body.summary}`),
        400,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");

    try {
      const record = await deps.launch({
        tenantId: tenant.id,
        principalId: principal.id,
        definitionId: body.definitionId,
        prompt: body.prompt,
        ...(body.modelPreference !== undefined
          ? { modelPreference: body.modelPreference }
          : {}),
      });
      return c.json({ item: taskView(record) }, 201);
    } catch (err) {
      if (
        err instanceof TaskDefinitionNotFoundError ||
        err instanceof TaskDefinitionNotTaskableError
      ) {
        return c.json(ErrorEnvelope("not_found", err.message), 404);
      }
      if (err instanceof TaskDefinitionNotLaunchableError) {
        return c.json(ErrorEnvelope("bad_request", err.message), 400);
      }
      return c.json(
        ErrorEnvelope(
          "task_launch_failed",
          err instanceof Error ? err.message : String(err),
        ),
        422,
      );
    }
  });

  app.get("/", deps.requireGrant("task:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const records = await deps.store.listTasks(tenant.id);
    return c.json({ items: records.map(taskView) });
  });

  app.get(
    "/:id",
    deps.requireGrant(idResource("task", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const id = c.req.param("id");
      const record = await deps.store.getTask(tenant.id, id);
      if (record === null) {
        return c.json(ErrorEnvelope("not_found", "task not found"), 404);
      }
      return c.json({ item: taskView(record) });
    },
  );

  return app;
}
