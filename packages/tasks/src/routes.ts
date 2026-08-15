// The HTTP surface of `@corbits/tasks`: create, list, get. Mounted by
// the host inside its tenant-scoped middleware (`TenantEnv`'s
// `tenant`/`principal` are always resolved before a handler here
// runs), mirroring `@corbits/chat`'s `createChatRoutes` — grant checks
// via `requireGrant`, request parsing via arktype at the boundary,
// route registration only, no business logic (that lives in
// `./launcher.ts`).
//
// Error copy at this boundary is written for the person who clicked
// "Start task" — plain words, no platform vocabulary (tenant,
// definition, deployed). The technical detail every launcher error
// carries goes to the server log instead, where an operator reads it.
import { type } from "arktype";
import { Hono } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import type { RequireGrant } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";
import { getLogger } from "@intx/log";

import {
  TaskDefinitionNotFoundError,
  TaskDefinitionNotLaunchableError,
  TaskDefinitionNotTaskableError,
  type LaunchTaskInput,
} from "./launcher";
import type { TaskRecord, TaskStore } from "./store";

const log = getLogger(["tasks", "routes"]);

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const AGENT_UNAVAILABLE_MESSAGE =
  "That agent isn't available for tasks in this workbench.";
const AGENT_NOT_READY_MESSAGE =
  "That agent isn't ready to take a task yet. Check its setup and try again.";
const TASK_START_FAILED_MESSAGE = "The task couldn't start. Try again.";

const CreateTaskBody = type({
  definitionId: "string > 0",
  prompt: "string > 0",
  "modelPreference?": "string > 0",
});

function taskView(record: TaskRecord) {
  return {
    id: record.id,
    definitionId: record.definitionId,
    agentName: record.agentName,
    prompt: record.prompt,
    modelPreference: record.modelPreference,
    status: record.status,
    runId: record.runId,
    runIds: [...record.runIds],
    stepCount: record.stepCount,
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
        ErrorEnvelope(
          "bad_request",
          `This task couldn't be read: ${body.summary}`,
        ),
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
      log.error`task create failed for ${body.definitionId}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      if (
        err instanceof TaskDefinitionNotFoundError ||
        err instanceof TaskDefinitionNotTaskableError
      ) {
        return c.json(
          ErrorEnvelope("not_found", AGENT_UNAVAILABLE_MESSAGE),
          404,
        );
      }
      if (err instanceof TaskDefinitionNotLaunchableError) {
        return c.json(
          ErrorEnvelope("bad_request", AGENT_NOT_READY_MESSAGE),
          400,
        );
      }
      return c.json(
        ErrorEnvelope("task_launch_failed", TASK_START_FAILED_MESSAGE),
        422,
      );
    }
  });

  // Tasks are personal: a prompt is written to one agent by one person
  // and is private the way a draft is — a deliberate, tighter scope
  // than the grant alone (which is tenant-wide). List and detail both
  // filter to the requesting principal's own tasks; a same-workbench
  // colleague's task reads as absent (404), never as forbidden, so the
  // response doesn't leak that it exists.
  app.get("/", deps.requireGrant("task:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const records = await deps.store.listTasks(tenant.id);
    const own = records.filter((record) => record.principalId === principal.id);
    return c.json({ items: own.map(taskView) });
  });

  app.get(
    "/:id",
    deps.requireGrant(idResource("task", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const id = c.req.param("id");
      const record = await deps.store.getTask(tenant.id, id);
      if (record === null || record.principalId !== principal.id) {
        return c.json(
          ErrorEnvelope("not_found", "That task doesn't exist."),
          404,
        );
      }
      return c.json({ item: taskView(record) });
    },
  );

  return app;
}
