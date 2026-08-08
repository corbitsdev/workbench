// The HTTP surface of `@corbits/routines`: CRUD over routines, run
// history, and "run now" — mounted by the hub inside its tenant-scoped
// middleware, the same convention `@corbits/chat`'s routes use.
//
// "Run now" and a scheduled fire are the same launcher call
// (`deps.launcher.launchRoutineRun`) with a different `triggeredBy`;
// this module never grows a second launch path for the unscheduled
// case.
import { Hono } from "hono";
import { type } from "arktype";

import type { TenantEnv } from "@intx/hub-api";
import type { RequireGrant } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";

import { RoutineTrigger, type RoutineTriggerT } from "./trigger";
import type { RoutineRow, RoutineRunRow, RoutineStore } from "./store";

export interface LaunchedRoutineRun {
  readonly runId: string;
}

/**
 * The launcher port: routines never launch a run themselves — they
 * hand the definition/input off to whatever launches folded runs on
 * the host (`@corbits/folded-runs` in this repo), then record the
 * correlation. Keeping this a port, not a direct dependency, is what
 * keeps `@corbits/routines` hosted-service-agnostic.
 */
export interface RoutineLauncher {
  launchRoutineRun(input: {
    tenantId: string;
    principalId: string;
    definitionId: string;
    input: Record<string, unknown>;
  }): Promise<LaunchedRoutineRun>;
}

/**
 * Enriches a correlated run id with whatever summary the host's own
 * run-listing surface exposes (status, timing, ...). Optional: a host
 * that mounts routines without wiring this still gets bare run ids and
 * timestamps back from `GET /routines/:id/runs`.
 */
export interface RunSummaryResolver {
  resolveRunSummary(
    tenantId: string,
    runId: string,
  ): Promise<Record<string, unknown> | undefined>;
}

export type CreateRoutineRoutesDeps = {
  store: RoutineStore;
  launcher: RoutineLauncher;
  requireGrant: RequireGrant;
  runSummaryResolver?: RunSummaryResolver;
};

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const CreateRoutineBody = type({
  name: "string",
  definitionId: "string",
  trigger: RoutineTrigger,
  scope: "'personal' | 'bench'",
  "input?": "Record<string, unknown>",
  "deliveryChannelId?": "string | null",
});

const UpdateRoutineBody = type({
  "name?": "string",
  "trigger?": RoutineTrigger,
  "input?": "Record<string, unknown>",
  "enabled?": "boolean",
  "deliveryChannelId?": "string | null",
});

const RunNowBody = type({
  "input?": "Record<string, unknown>",
});

/**
 * The wire shape for a routine — never a raw id-only reference, always
 * the name and structured trigger a UI can render directly, per the
 * platform's "no raw IDs on screen" floor.
 */
function routineView(row: RoutineRow) {
  return {
    id: row.id,
    name: row.name,
    definitionId: row.definitionId,
    trigger: row.trigger,
    scope: row.scope,
    input: row.input,
    enabled: row.enabled,
    deliveryChannelId: row.deliveryChannelId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function runView(
  row: RoutineRunRow,
  resolver: RunSummaryResolver | undefined,
) {
  const summary = await resolver?.resolveRunSummary(row.tenantId, row.runId);
  return {
    runId: row.runId,
    triggeredBy: row.triggeredBy,
    createdAt: row.createdAt.toISOString(),
    ...(summary !== undefined ? { run: summary } : {}),
  };
}

export function createRoutineRoutes(
  deps: CreateRoutineRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.post(
    "/routines",
    deps.requireGrant("workflow-run:*", "create"),
    async (c) => {
      const body = CreateRoutineBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid routine body: ${body.summary}`),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");

      const row = await deps.store.createRoutine({
        tenantId: tenant.id,
        name: body.name,
        definitionId: body.definitionId,
        trigger: body.trigger as RoutineTriggerT,
        scope: body.scope,
        input: body.input ?? {},
        deliveryChannelId: body.deliveryChannelId ?? null,
        createdBy: principal.id,
      });

      return c.json(routineView(row), 201);
    },
  );

  app.get(
    "/routines",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const rows = await deps.store.listRoutines(tenant.id);
      return c.json({ items: rows.map(routineView) });
    },
  );

  app.get(
    "/routines/:id",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const row = await deps.store.getRoutine(tenant.id, c.req.param("id"));
      if (row === undefined) {
        return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
      }
      return c.json(routineView(row));
    },
  );

  app.patch(
    "/routines/:id",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const body = UpdateRoutineBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope(
            "bad_request",
            `invalid routine patch: ${body.summary}`,
          ),
          400,
        );
      }

      const tenant = c.get("tenant");
      const routineId = c.req.param("id");
      const existing = await deps.store.getRoutine(tenant.id, routineId);
      if (existing === undefined) {
        return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
      }

      const row = await deps.store.updateRoutine(tenant.id, routineId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.trigger !== undefined
          ? { trigger: body.trigger as RoutineTriggerT }
          : {}),
        ...(body.input !== undefined ? { input: body.input } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.deliveryChannelId !== undefined
          ? { deliveryChannelId: body.deliveryChannelId }
          : {}),
      });

      return c.json(routineView(row));
    },
  );

  app.delete(
    "/routines/:id",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const deleted = await deps.store.deleteRoutine(
        tenant.id,
        c.req.param("id"),
      );
      if (!deleted) {
        return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
      }
      return c.body(null, 204);
    },
  );

  app.get(
    "/routines/:id/runs",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const routineId = c.req.param("id");
      const existing = await deps.store.getRoutine(tenant.id, routineId);
      if (existing === undefined) {
        return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
      }
      const rows = await deps.store.listRunsForRoutine(tenant.id, routineId);
      const items = await Promise.all(
        rows.map((row) => runView(row, deps.runSummaryResolver)),
      );
      return c.json({ items });
    },
  );

  app.post(
    "/routines/:id/run",
    deps.requireGrant(idResource("workflow-run", "id"), "create"),
    async (c) => {
      const body = RunNowBody(await c.req.json().catch(() => ({})));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid run body: ${body.summary}`),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const routineId = c.req.param("id");
      const existing = await deps.store.getRoutine(tenant.id, routineId);
      if (existing === undefined) {
        return c.json(ErrorEnvelope("not_found", "routine not found"), 404);
      }

      // "Run now" is an unscheduled fire of the exact launcher a
      // scheduled trigger would call — the only difference is
      // `triggeredBy`, never a second launch code path.
      const launched = await deps.launcher.launchRoutineRun({
        tenantId: tenant.id,
        principalId: principal.id,
        definitionId: existing.definitionId,
        input: body.input ?? existing.input,
      });

      await deps.store.recordRoutineRun({
        tenantId: tenant.id,
        routineId,
        runId: launched.runId,
        triggeredBy: "manual",
      });

      return c.json({ runId: launched.runId }, 201);
    },
  );

  return app;
}

/**
 * Fires a scheduled routine exactly the way `POST /routines/:id/run`
 * fires a manual one — same `launcher.launchRoutineRun` call, same
 * `recordRoutineRun` bookkeeping — with `triggeredBy: "schedule"` the
 * only distinguishing fact. A cron/interval scheduler calls this
 * directly, tenant and routine already resolved; it never
 * re-implements the launch or the correlation write.
 */
export async function fireScheduledRoutine(
  deps: { store: RoutineStore; launcher: RoutineLauncher },
  params: { tenantId: string; routine: RoutineRow },
): Promise<LaunchedRoutineRun> {
  if (!params.routine.enabled) {
    throw new Error(
      `routine ${params.routine.id} is disabled; a scheduler must not fire it`,
    );
  }
  const launched = await deps.launcher.launchRoutineRun({
    tenantId: params.tenantId,
    principalId: params.routine.createdBy,
    definitionId: params.routine.definitionId,
    input: params.routine.input,
  });
  await deps.store.recordRoutineRun({
    tenantId: params.tenantId,
    routineId: params.routine.id,
    runId: launched.runId,
    triggeredBy: "schedule",
  });
  return launched;
}
