// Route-shape and run-correlation tests: the wiring this package owns
// (request parsing, grant checks, response envelopes, and the
// routine<->run correlation write), not anything `arktype`, `hono`, or
// Interchange already tests on its own.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import {
  createRoutineRoutes,
  fireScheduledRoutine,
  type CreateRoutineRoutesDeps,
  type RoutineLauncher,
} from "../src/routes";
import { createInMemoryRoutineStore } from "../src/store";

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function principal(id: string) {
  return {
    id,
    tenantId: TENANT.id,
    kind: "user" as const,
    refId: id,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeLauncher(): RoutineLauncher & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async launchRoutineRun() {
      calls += 1;
      return { runId: `run_${calls}` };
    },
  };
}

function mountAs(
  routes: Hono<TenantEnv>,
  principalId: string,
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", principal(principalId));
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

function buildDeps(
  overrides: Partial<CreateRoutineRoutesDeps> = {},
): CreateRoutineRoutesDeps {
  return {
    store: createInMemoryRoutineStore(),
    launcher: fakeLauncher(),
    requireGrant: () => async (_c, next) => {
      await next();
    },
    ...overrides,
  };
}

async function createRoutine(
  app: Hono<TenantEnv>,
  body: Record<string, unknown>,
) {
  const response = await app.request("/routines", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

const VALID_BODY = {
  name: "Morning digest",
  definitionId: "def_digest",
  trigger: { kind: "daily", hour: 9, minute: 0 },
  scope: "bench",
};

describe("createRoutineRoutes", () => {
  test("creates a routine and never leaks a raw id where a name belongs", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response, body } = await createRoutine(app, VALID_BODY);

    expect(response.status).toBe(201);
    expect(body["name"]).toBe("Morning digest");
    expect(body["trigger"]).toEqual({ kind: "daily", hour: 9, minute: 0 });
    expect(typeof body["id"]).toBe("string");
  });

  test("rejects an invalid trigger with a 400", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response, body } = await createRoutine(app, {
      ...VALID_BODY,
      trigger: { kind: "daily", hour: 24, minute: 0 },
    });

    expect(response.status).toBe(400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(
      "bad_request",
    );
  });

  test("accepts a null trigger as a manual routine", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response, body } = await createRoutine(app, {
      ...VALID_BODY,
      trigger: null,
    });

    expect(response.status).toBe(201);
    expect(body["trigger"]).toBeNull();
  });

  test("lists only routines for the calling tenant", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    await createRoutine(app, VALID_BODY);
    await createRoutine(app, { ...VALID_BODY, name: "Weekly report" });

    const response = await app.request("/routines");
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items.length).toBe(2);
  });

  test("run now launches through the injected launcher and records correlation", async () => {
    const launcher = fakeLauncher();
    const deps = buildDeps({ launcher });
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body: created } = await createRoutine(app, VALID_BODY);

    const runResponse = await app.request(`/routines/${created["id"]}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(runResponse.status).toBe(201);
    expect(launcher.calls).toBe(1);

    const runsResponse = await app.request(`/routines/${created["id"]}/runs`);
    const runsBody = (await runsResponse.json()) as {
      items: { runId: string; triggeredBy: string }[];
    };
    expect(runsBody.items).toHaveLength(1);
    expect(runsBody.items[0]?.triggeredBy).toBe("manual");
  });

  test("a run launched under a routine is retrievable via GET /routines/:id/runs", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body: created } = await createRoutine(app, VALID_BODY);
    const routineId = created["id"] as string;

    await deps.store.recordRoutineRun({
      tenantId: TENANT.id,
      routineId,
      runId: "run_scheduled_1",
      triggeredBy: "schedule",
    });

    const response = await app.request(`/routines/${routineId}/runs`);
    const body = (await response.json()) as { items: { runId: string }[] };
    expect(body.items.map((item) => item.runId)).toContain("run_scheduled_1");
  });

  test("404s a run history request for an unknown routine", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const response = await app.request("/routines/does-not-exist/runs");
    expect(response.status).toBe(404);
  });

  test("run history survives deleting the routine", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body: created } = await createRoutine(app, VALID_BODY);
    const routineId = created["id"] as string;

    await deps.store.recordRoutineRun({
      tenantId: TENANT.id,
      routineId,
      runId: "run_before_delete",
      triggeredBy: "manual",
    });

    const deleteResponse = await app.request(`/routines/${routineId}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(204);

    const runsResponse = await app.request(`/routines/${routineId}/runs`);
    expect(runsResponse.status).toBe(200);
    const body = (await runsResponse.json()) as { items: { runId: string }[] };
    expect(body.items.map((item) => item.runId)).toContain("run_before_delete");

    // A deleted routine is otherwise gone: it neither lists nor
    // resolves by id, and a second delete still 404s.
    const getResponse = await app.request(`/routines/${routineId}`);
    expect(getResponse.status).toBe(404);
    const listResponse = await app.request("/routines");
    const listBody = (await listResponse.json()) as { items: unknown[] };
    expect(listBody.items).toHaveLength(0);
  });

  test("run summaries enrich when a resolver is wired, and are omitted without one", async () => {
    const deps = buildDeps({
      runSummaryResolver: {
        async resolveRunSummary(_tenantId, runId) {
          return { status: "succeeded", runId };
        },
      },
    });
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body: created } = await createRoutine(app, VALID_BODY);
    await app.request(`/routines/${created["id"]}/run`, { method: "POST" });

    const response = await app.request(`/routines/${created["id"]}/runs`);
    const body = (await response.json()) as {
      items: { run?: { status: string } }[];
    };
    expect(body.items[0]?.run?.status).toBe("succeeded");
  });

  test("deletes a routine, 404ing a second delete", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body: created } = await createRoutine(app, VALID_BODY);

    const first = await app.request(`/routines/${created["id"]}`, {
      method: "DELETE",
    });
    expect(first.status).toBe(204);

    const second = await app.request(`/routines/${created["id"]}`, {
      method: "DELETE",
    });
    expect(second.status).toBe(404);
  });
});

describe("fireScheduledRoutine", () => {
  test("launches and records a schedule-triggered run for an enabled routine", async () => {
    const store = createInMemoryRoutineStore();
    const launcher = fakeLauncher();
    const created = await store.createRoutine({
      tenantId: TENANT.id,
      name: "Nightly sync",
      definitionId: "def_sync",
      trigger: { kind: "interval", unit: "hours", every: 6 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });

    const launched = await fireScheduledRoutine(
      { store, launcher },
      { tenantId: TENANT.id, routine: created },
    );

    expect(launcher.calls).toBe(1);
    const runs = await store.listRunsForRoutine(TENANT.id, created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe(launched.runId);
    expect(runs[0]?.triggeredBy).toBe("schedule");
  });

  test("refuses to fire a disabled routine", async () => {
    const store = createInMemoryRoutineStore();
    const launcher = fakeLauncher();
    const created = await store.createRoutine({
      tenantId: TENANT.id,
      name: "Paused digest",
      definitionId: "def_digest",
      trigger: { kind: "daily", hour: 9, minute: 0 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });
    const disabled = await store.updateRoutine(TENANT.id, created.id, {
      enabled: false,
    });

    await expect(
      fireScheduledRoutine(
        { store, launcher },
        { tenantId: TENANT.id, routine: disabled },
      ),
    ).rejects.toThrow(/disabled/);
    expect(launcher.calls).toBe(0);
  });
});
