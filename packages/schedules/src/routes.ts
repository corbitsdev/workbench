// The full HTTP surface of `@corbits/schedules`: tenant-scoped
// schedule CRUD plus a "run now" action. Mounted by the hub inside its
// tenant-scoped middleware — mirroring `@corbits/chat`'s
// `createChatRoutes` and `@workbench/echo`'s `createEchoRoutes` — so
// `TenantEnv`'s `tenant`/`principal` are always resolved before a
// handler here runs. This module owns route registration, request
// parsing (arktype at the boundary), and grant checks only; storage
// lives in `./store`, trigger arithmetic in `./trigger`, and launching
// in `./launcher`.
import { Hono } from "hono";
import { type } from "arktype";

import type { TenantEnv } from "@intx/hub-api";
import type { RequireGrant } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";

import type { ScheduleLauncher } from "./launcher";
import type { ScheduleStore } from "./store";
import {
  computeNextRun,
  InvalidTriggerError,
  validateTrigger,
  type ScheduleTrigger,
} from "./trigger";

export type CreateScheduleRoutesDeps = {
  store: ScheduleStore;
  launcher: ScheduleLauncher;
  requireGrant: RequireGrant;
  /** Injectable clock so tests control "now" and "id" without real randomness/timers. */
  now?: () => Date;
  generateScheduleId?: () => string;
};

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const TriggerSchema = type({
  kind: "'cron'",
  expression: "string",
}).or(
  type({
    kind: "'interval'",
    ms: "number",
  }),
);

const CreateScheduleBody = type({
  workflowDefinitionId: "string",
  trigger: TriggerSchema,
  "input?": "unknown",
  "enabled?": "boolean",
});

const UpdateScheduleBody = type({
  "enabled?": "boolean",
  "trigger?": TriggerSchema,
  "input?": "unknown",
});

function defaultScheduleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sch_${hex}`;
}

function scheduleView(row: {
  id: string;
  tenantId: string;
  workflowDefinitionId: string;
  trigger: ScheduleTrigger;
  input: unknown;
  enabled: boolean;
  createdBy: string;
  lastRunAt: Date | null;
  nextRunAt: Date;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workflowDefinitionId: row.workflowDefinitionId,
    trigger: row.trigger,
    input: row.input,
    enabled: row.enabled,
    createdBy: row.createdBy,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createScheduleRoutes(
  deps: CreateScheduleRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const now = deps.now ?? (() => new Date());
  const generateScheduleId = deps.generateScheduleId ?? defaultScheduleId;

  app.post(
    "/schedules",
    deps.requireGrant("schedule:*", "create"),
    async (c) => {
      const body = CreateScheduleBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope(
            "bad_request",
            `invalid schedule body: ${body.summary}`,
          ),
          400,
        );
      }

      try {
        validateTrigger(body.trigger);
      } catch (error) {
        if (error instanceof InvalidTriggerError) {
          return c.json(ErrorEnvelope("bad_request", error.message), 400);
        }
        throw error;
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const createdAt = now();

      const row = await deps.store.create({
        id: generateScheduleId(),
        tenantId: tenant.id,
        workflowDefinitionId: body.workflowDefinitionId,
        trigger: body.trigger,
        input: body.input ?? null,
        enabled: body.enabled ?? true,
        createdBy: principal.id,
        nextRunAt: computeNextRun(body.trigger, createdAt),
      });

      return c.json(scheduleView(row), 201);
    },
  );

  app.get("/schedules", deps.requireGrant("schedule:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const rows = await deps.store.list(tenant.id);
    return c.json({ items: rows.map(scheduleView) });
  });

  app.get(
    "/schedules/:id",
    deps.requireGrant(idResource("schedule", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const id = c.req.param("id");
      const row = await deps.store.get(tenant.id, id);
      if (row === undefined) {
        return c.json(ErrorEnvelope("not_found", "schedule not found"), 404);
      }
      return c.json(scheduleView(row));
    },
  );

  app.patch(
    "/schedules/:id",
    deps.requireGrant(idResource("schedule", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const id = c.req.param("id");

      const existing = await deps.store.get(tenant.id, id);
      if (existing === undefined) {
        return c.json(ErrorEnvelope("not_found", "schedule not found"), 404);
      }

      const body = UpdateScheduleBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope(
            "bad_request",
            `invalid schedule patch: ${body.summary}`,
          ),
          400,
        );
      }

      if (body.trigger !== undefined) {
        try {
          validateTrigger(body.trigger);
        } catch (error) {
          if (error instanceof InvalidTriggerError) {
            return c.json(ErrorEnvelope("bad_request", error.message), 400);
          }
          throw error;
        }
      }

      const nextRunAt =
        body.trigger !== undefined
          ? computeNextRun(body.trigger, now())
          : undefined;

      const row = await deps.store.update(tenant.id, id, {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
        ...(body.input !== undefined ? { input: body.input } : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      });
      if (row === undefined) {
        return c.json(ErrorEnvelope("not_found", "schedule not found"), 404);
      }
      return c.json(scheduleView(row));
    },
  );

  app.delete(
    "/schedules/:id",
    deps.requireGrant(idResource("schedule", "id"), "delete"),
    async (c) => {
      const tenant = c.get("tenant");
      const id = c.req.param("id");
      const deleted = await deps.store.delete(tenant.id, id);
      if (!deleted) {
        return c.json(ErrorEnvelope("not_found", "schedule not found"), 404);
      }
      return c.body(null, 204);
    },
  );

  app.post(
    "/schedules/:id/run-now",
    deps.requireGrant(idResource("schedule", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const id = c.req.param("id");
      const row = await deps.store.get(tenant.id, id);
      if (row === undefined) {
        return c.json(ErrorEnvelope("not_found", "schedule not found"), 404);
      }

      const launched = await deps.launcher.launchScheduledRun({
        tenantId: tenant.id,
        scheduleId: row.id,
        workflowDefinitionId: row.workflowDefinitionId,
        createdBy: row.createdBy,
        input: row.input,
      });
      await deps.store.recordRun({
        id: row.id,
        lastRunAt: now(),
        nextRunAt: row.nextRunAt,
      });

      return c.json(
        { instanceId: launched.instanceId, address: launched.address },
        201,
      );
    },
  );

  return app;
}
