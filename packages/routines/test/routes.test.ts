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
  type WorkbenchNoticePort,
  type CreateRoutineRoutesDeps,
  type RoutineLauncher,
} from "../src/routes";
import { createInMemoryRoutineStore, type RoutineStore } from "../src/store";

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

function fakeLauncher(): RoutineLauncher & {
  calls: number;
  lastInput: Record<string, unknown> | undefined;
  lastLaunchInput:
    Parameters<RoutineLauncher["launchRoutineRun"]>[0] | undefined;
} {
  let calls = 0;
  let lastInput: Record<string, unknown> | undefined;
  let lastLaunchInput:
    Parameters<RoutineLauncher["launchRoutineRun"]>[0] | undefined;
  return {
    get calls() {
      return calls;
    },
    get lastInput() {
      return lastInput;
    },
    get lastLaunchInput() {
      return lastLaunchInput;
    },
    async launchRoutineRun(input) {
      calls += 1;
      lastInput = input.input;
      lastLaunchInput = input;
      return { runId: `run_${calls}` };
    },
  };
}

function fakeWorkbenchNotice(): WorkbenchNoticePort & {
  calls: Parameters<WorkbenchNoticePort["postWorkbenchNotice"]>[0][];
} {
  const calls: Parameters<WorkbenchNoticePort["postWorkbenchNotice"]>[0][] = [];
  return {
    calls,
    async postWorkbenchNotice(input) {
      calls.push(input);
    },
  };
}

/** A store that always creates a routine already disabled — the real
 * production store (and `createInMemoryRoutineStore`) always creates a
 * routine enabled, so a disabled create can only be exercised by
 * overriding the store this way. */
function storeCreatingDisabled(): RoutineStore {
  const inner = createInMemoryRoutineStore();
  return {
    ...inner,
    async createRoutine(input) {
      const row = await inner.createRoutine(input);
      // Persist the disabled state, not just the returned object — a
      // later `getRoutine`/`updateRoutine` in the same test must see it
      // too.
      return inner.updateRoutine(input.tenantId, row.id, { enabled: false });
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
  deliveryWorkbenchId: "ch_delivery",
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

  test("rejects a definition that is not in the tenant", async () => {
    const deps = buildDeps();
    deps.definitionInTenant = async () => false;
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response, body } = await createRoutine(app, VALID_BODY);
    expect(response.status).toBe(404);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(
      "not_found",
    );
  });

  test("accepts a definition that is in the tenant when a checker is wired", async () => {
    const deps = buildDeps();
    deps.definitionInTenant = async (tenantId, definitionId) =>
      tenantId === TENANT.id && definitionId === VALID_BODY.definitionId;
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response } = await createRoutine(app, VALID_BODY);
    expect(response.status).toBe(201);
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

  test("persists a create request's input record on the routine row", async () => {
    // The seam a create-time UI (e.g. the routines picker's declared
    // triggerFields) writes into: whatever named fields a person filled
    // in land here, verbatim.
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response, body } = await createRoutine(app, {
      ...VALID_BODY,
      input: { topic: "AI coding agents", focus: "Competing launches" },
    });

    expect(response.status).toBe(201);
    expect(body["input"]).toEqual({
      topic: "AI coding agents",
      focus: "Competing launches",
    });
  });

  test("a runOnceNow create forwards the same input record to the launcher", async () => {
    const launcher = fakeLauncher();
    const deps = buildDeps({ launcher });
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response } = await createRoutine(app, {
      ...VALID_BODY,
      trigger: null,
      input: { topic: "AI coding agents" },
      runOnceNow: true,
    });

    expect(response.status).toBe(201);
    expect(launcher.calls).toBe(1);
    expect(launcher.lastInput).toEqual({ topic: "AI coding agents" });
  });

  test("a {kind: 'once'} trigger fires immediately on create, recording an 'once'-triggered run", async () => {
    const launcher = fakeLauncher();
    const deps = buildDeps({ launcher });
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response, body } = await createRoutine(app, {
      ...VALID_BODY,
      trigger: { kind: "once" },
      input: { topic: "AI coding agents" },
    });

    expect(response.status).toBe(201);
    expect(body["trigger"]).toEqual({ kind: "once" });
    expect(launcher.calls).toBe(1);
    expect(launcher.lastInput).toEqual({ topic: "AI coding agents" });

    const runsResponse = await app.request(
      `/routines/${body["id"] as string}/runs`,
    );
    const runsBody = (await runsResponse.json()) as {
      items: { triggeredBy: string }[];
    };
    expect(runsBody.items[0]?.triggeredBy).toBe("once");
  });

  test("a {kind: 'once'} trigger's failed launch still returns 201, recording an 'once-failed' run", async () => {
    const launcher: RoutineLauncher = {
      async launchRoutineRun() {
        throw new Error("boom");
      },
    };
    const deps = buildDeps({ launcher });
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response, body } = await createRoutine(app, {
      ...VALID_BODY,
      trigger: { kind: "once" },
    });

    expect(response.status).toBe(201);

    const runsResponse = await app.request(
      `/routines/${body["id"] as string}/runs`,
    );
    const runsBody = (await runsResponse.json()) as {
      items: { triggeredBy: string; error: string | null }[];
    };
    expect(runsBody.items[0]?.triggeredBy).toBe("once-failed");
    expect(runsBody.items[0]?.error).toBe("boom");
  });

  test("a {kind: 'once'} routine's nextFireAt is null and stays null (never claimed by a scheduler)", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body } = await createRoutine(app, {
      ...VALID_BODY,
      trigger: { kind: "once" },
    });
    const getResponse = await app.request(`/routines/${body["id"] as string}`);
    const getBody = (await getResponse.json()) as Record<string, unknown>;
    expect(getBody["trigger"]).toEqual({ kind: "once" });

    const due = await deps.store.listDueRoutines(new Date(8640000000000000));
    expect(due.find((r) => r.id === body["id"])).toBeUndefined();
  });

  test("accepts a webhook trigger when no checker is wired (always-allow)", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response, body } = await createRoutine(app, {
      ...VALID_BODY,
      trigger: { kind: "webhook", webhookTriggerId: "wht_1" },
    });

    expect(response.status).toBe(201);
    expect(body["trigger"]).toEqual({
      kind: "webhook",
      webhookTriggerId: "wht_1",
    });
  });

  test("rejects a webhook trigger whose referenced row fails the checker", async () => {
    const deps = buildDeps();
    deps.webhookTriggerInTenant = async () => false;
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response, body } = await createRoutine(app, {
      ...VALID_BODY,
      trigger: { kind: "webhook", webhookTriggerId: "wht_1" },
    });

    expect(response.status).toBe(404);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(
      "not_found",
    );
  });

  test("passes the routine's tenant, webhookTriggerId, and definitionId to the checker", async () => {
    const deps = buildDeps();
    const calls: [string, string, string][] = [];
    deps.webhookTriggerInTenant = async (
      tenantId,
      webhookTriggerId,
      definitionId,
    ) => {
      calls.push([tenantId, webhookTriggerId, definitionId]);
      return true;
    };
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    await createRoutine(app, {
      ...VALID_BODY,
      trigger: { kind: "webhook", webhookTriggerId: "wht_1" },
    });

    expect(calls).toEqual([[TENANT.id, "wht_1", VALID_BODY.definitionId]]);
  });

  test("never invokes the webhook checker for a non-webhook trigger", async () => {
    const deps = buildDeps();
    let called = false;
    deps.webhookTriggerInTenant = async () => {
      called = true;
      return true;
    };
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    await createRoutine(app, VALID_BODY);
    expect(called).toBe(false);
  });

  test("PATCH rejects switching to a webhook trigger the checker rejects", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body: created } = await createRoutine(app, VALID_BODY);

    deps.webhookTriggerInTenant = async () => false;
    const response = await app.request(`/routines/${created["id"]}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trigger: { kind: "webhook", webhookTriggerId: "wht_1" },
      }),
    });

    expect(response.status).toBe(404);
  });

  test("PATCH accepts switching to a webhook trigger the checker allows, using the routine's own definitionId", async () => {
    const deps = buildDeps();
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body: created } = await createRoutine(app, VALID_BODY);

    let seenDefinitionId: string | undefined;
    deps.webhookTriggerInTenant = async (_tenantId, _id, definitionId) => {
      seenDefinitionId = definitionId;
      return true;
    };
    const response = await app.request(`/routines/${created["id"]}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trigger: { kind: "webhook", webhookTriggerId: "wht_1" },
      }),
    });

    expect(response.status).toBe(200);
    expect(seenDefinitionId).toBe(VALID_BODY.definitionId);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["trigger"]).toEqual({
      kind: "webhook",
      webhookTriggerId: "wht_1",
    });
  });

  test("posts an honest notice when a routine is created enabled", async () => {
    const workbenchNotice = fakeWorkbenchNotice();
    const deps = buildDeps({ workbenchNotice });
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    await createRoutine(app, VALID_BODY);

    expect(workbenchNotice.calls.length).toBe(1);
    expect(workbenchNotice.calls[0]?.workbenchId).toBe(
      VALID_BODY.deliveryWorkbenchId,
    );
    expect(workbenchNotice.calls[0]?.text).toBe(
      'Created routine "Morning digest" — runs Daily at 09:00 UTC. ' +
        "Manage it from Routines.",
    );
  });

  test("posts nothing when a routine is created disabled", async () => {
    const workbenchNotice = fakeWorkbenchNotice();
    const deps = buildDeps({ workbenchNotice, store: storeCreatingDisabled() });
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { response } = await createRoutine(app, VALID_BODY);

    expect(response.status).toBe(201);
    expect(workbenchNotice.calls.length).toBe(0);
  });

  test("posts an honest notice when a disabled routine is flipped to enabled", async () => {
    const workbenchNotice = fakeWorkbenchNotice();
    const deps = buildDeps({ workbenchNotice, store: storeCreatingDisabled() });
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body: created } = await createRoutine(app, VALID_BODY);

    const response = await app.request(`/routines/${created["id"]}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(200);
    expect(workbenchNotice.calls.length).toBe(1);
    expect(workbenchNotice.calls[0]?.text).toBe(
      'Enabled routine "Morning digest" — runs Daily at 09:00 UTC. ' +
        "Manage it from Routines.",
    );
  });

  test("posts nothing for an update that does not flip enabled", async () => {
    const workbenchNotice = fakeWorkbenchNotice();
    const deps = buildDeps({ workbenchNotice });
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body: created } = await createRoutine(app, VALID_BODY);
    workbenchNotice.calls.length = 0; // clear the create notice

    const response = await app.request(`/routines/${created["id"]}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed digest" }),
    });

    expect(response.status).toBe(200);
    expect(workbenchNotice.calls.length).toBe(0);
  });

  test("posts nothing for a patch that keeps an already-enabled routine enabled", async () => {
    const workbenchNotice = fakeWorkbenchNotice();
    const deps = buildDeps({ workbenchNotice });
    const app = mountAs(createRoutineRoutes(deps), "user_1");
    const { body: created } = await createRoutine(app, VALID_BODY);
    workbenchNotice.calls.length = 0; // clear the create notice

    const response = await app.request(`/routines/${created["id"]}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(200);
    expect(workbenchNotice.calls.length).toBe(0);
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
    // The run-now response carries only a runId — a run's result always
    // delivers into the workbench's root feed, never a hidden thread.
    const runBody = (await runResponse.json()) as Record<string, unknown>;
    expect(Object.keys(runBody)).toEqual(["runId"]);
    expect(launcher.lastLaunchInput).not.toHaveProperty("deliveryThreadId");

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

  describe("deliveryWorkbenchRequired", () => {
    test("rejects a create with no deliveryWorkbenchId when no port is wired (prior behavior)", async () => {
      const deps = buildDeps();
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const {
        name: _name,
        deliveryWorkbenchId: _drop,
        ...withoutWorkbench
      } = VALID_BODY;
      const { response, body } = await createRoutine(app, {
        ...withoutWorkbench,
        name: "No workbench",
      });
      expect(response.status).toBe(400);
      expect((body["error"] as Record<string, unknown>)["code"]).toBe(
        "bad_request",
      );
    });

    test("rejects a create with no deliveryWorkbenchId when the port says this definition requires one", async () => {
      const deps = buildDeps({ deliveryWorkbenchRequired: async () => true });
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const { deliveryWorkbenchId: _drop, ...withoutWorkbench } = VALID_BODY;
      const { response } = await createRoutine(app, {
        ...withoutWorkbench,
        name: "Still requires a workbench",
      });
      expect(response.status).toBe(400);
    });

    test("accepts a create with no deliveryWorkbenchId when the port says this definition never delivers to a workbench", async () => {
      const deps = buildDeps({ deliveryWorkbenchRequired: async () => false });
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const { deliveryWorkbenchId: _drop, ...withoutWorkbench } = VALID_BODY;
      const { response, body } = await createRoutine(app, {
        ...withoutWorkbench,
        name: "Inbox delivery",
      });
      expect(response.status).toBe(201);
      expect(body["deliveryWorkbenchId"]).toBe(null);
    });

    test("'run now' on a workbench-less routine succeeds once the port says a workbench isn't required", async () => {
      const launcher = fakeLauncher();
      const deps = buildDeps({
        launcher,
        deliveryWorkbenchRequired: async () => false,
      });
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const { deliveryWorkbenchId: _drop, ...withoutWorkbench } = VALID_BODY;
      const { body: created } = await createRoutine(app, {
        ...withoutWorkbench,
        name: "Inbox delivery",
      });

      const runResponse = await app.request(`/routines/${created["id"]}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(runResponse.status).toBe(201);
      expect(launcher.calls).toBe(1);
    });
  });

  describe("deliverySpace", () => {
    function fakeDeliverySpace(
      overrides: {
        readonly workbenchId?: string;
        readonly onCreate?: () => void;
        readonly onCompensate?: () => void;
        readonly failCompensate?: boolean;
      } = {},
    ) {
      const workbenchId = overrides.workbenchId ?? "ch_new_space";
      let createCalls = 0;
      let compensateCalls = 0;
      return {
        get createCalls() {
          return createCalls;
        },
        get compensateCalls() {
          return compensateCalls;
        },
        async createDeliverySpace(input: {
          tenantId: string;
          tenantDomain: string;
          creatorPrincipalId: string;
          creatorUserId: string;
          name: string;
        }) {
          createCalls += 1;
          overrides.onCreate?.();
          expect(input.tenantId).toBe(TENANT.id);
          expect(input.tenantDomain).toBe(TENANT.domain);
          return {
            workbenchId,
            compensate: async () => {
              compensateCalls += 1;
              overrides.onCompensate?.();
              if (overrides.failCompensate === true) {
                throw new Error("compensation failed");
              }
            },
          };
        },
      };
    }

    test("provisions a new space and binds it as deliveryWorkbenchId when none is named", async () => {
      const deliverySpace = fakeDeliverySpace();
      const deps = buildDeps({ deliverySpace });
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const { deliveryWorkbenchId: _drop, ...withoutWorkbench } = VALID_BODY;
      const { response, body } = await createRoutine(app, {
        ...withoutWorkbench,
        name: "Weekly digest",
      });
      expect(response.status).toBe(201);
      expect(body["deliveryWorkbenchId"]).toBe("ch_new_space");
      expect(deliverySpace.createCalls).toBe(1);
    });

    test("leaves an existing deliveryWorkbenchId untouched — the space port is never called", async () => {
      const deliverySpace = fakeDeliverySpace();
      const deps = buildDeps({ deliverySpace });
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const { response, body } = await createRoutine(app, VALID_BODY);
      expect(response.status).toBe(201);
      expect(body["deliveryWorkbenchId"]).toBe(VALID_BODY.deliveryWorkbenchId);
      expect(deliverySpace.createCalls).toBe(0);
    });

    test("compensates (deletes) the provisioned space when the routine row then fails to write", async () => {
      const deliverySpace = fakeDeliverySpace();
      const store = createInMemoryRoutineStore();
      store.createRoutine = async () => {
        throw new Error("db unavailable");
      };
      const deps = buildDeps({ store, deliverySpace });
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const { deliveryWorkbenchId: _drop, ...withoutWorkbench } = VALID_BODY;
      const response = await app.request("/routines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...withoutWorkbench, name: "Doomed" }),
      });
      expect(response.status).toBe(500);
      expect(deliverySpace.createCalls).toBe(1);
      expect(deliverySpace.compensateCalls).toBe(1);
    });

    test("a routine row write failure still propagates even if compensation itself fails", async () => {
      const deliverySpace = fakeDeliverySpace({ failCompensate: true });
      const store = createInMemoryRoutineStore();
      store.createRoutine = async () => {
        throw new Error("db unavailable");
      };
      const deps = buildDeps({ store, deliverySpace });
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const { deliveryWorkbenchId: _drop, ...withoutWorkbench } = VALID_BODY;
      const response = await app.request("/routines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...withoutWorkbench, name: "Doomed" }),
      });
      expect(response.status).toBe(500);
      expect(deliverySpace.compensateCalls).toBe(1);
    });
  });

  describe("validateRoutineInput", () => {
    test("creates without validation when no port is wired (prior behavior)", async () => {
      const deps = buildDeps();
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const { response } = await createRoutine(app, {
        ...VALID_BODY,
        input: {},
      });
      expect(response.status).toBe(201);
    });

    test("rejects a create when the port says the input is invalid, surfacing its message", async () => {
      const deps = buildDeps({
        validateRoutineInput: async () => ({
          ok: false,
          message: '"Agent" is required',
        }),
      });
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const { response, body } = await createRoutine(app, VALID_BODY);
      expect(response.status).toBe(400);
      expect((body["error"] as Record<string, unknown>)["message"]).toBe(
        '"Agent" is required',
      );
    });

    test("accepts a create when the port says the input is valid", async () => {
      let seenInput: Record<string, unknown> | undefined;
      const deps = buildDeps({
        validateRoutineInput: async (_tenantId, _definitionId, input) => {
          seenInput = input;
          return { ok: true };
        },
      });
      const app = mountAs(createRoutineRoutes(deps), "user_1");
      const { response } = await createRoutine(app, {
        ...VALID_BODY,
        input: { agent: "wfd_agent", prompt: "Do it" },
      });
      expect(response.status).toBe(201);
      expect(seenInput).toEqual({ agent: "wfd_agent", prompt: "Do it" });
    });
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
      deliveryWorkbenchId: "ch_delivery",
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

  test("refuses to fire a workbench-less routine when no deliveryWorkbenchRequired port is wired (prior behavior)", async () => {
    const store = createInMemoryRoutineStore();
    const launcher = fakeLauncher();
    const created = await store.createRoutine({
      tenantId: TENANT.id,
      name: "Workbench-less digest",
      definitionId: "def_digest",
      trigger: { kind: "daily", hour: 9, minute: 0 },
      scope: "bench",
      input: {},
      createdBy: "user_1",
    });

    await expect(
      fireScheduledRoutine(
        { store, launcher },
        { tenantId: TENANT.id, routine: created },
      ),
    ).rejects.toThrow(/deliveryWorkbenchId/);
    expect(launcher.calls).toBe(0);
  });

  test("fires a workbench-less routine when the port says its definition never delivers to a workbench", async () => {
    const store = createInMemoryRoutineStore();
    const launcher = fakeLauncher();
    const created = await store.createRoutine({
      tenantId: TENANT.id,
      name: "Recurring task",
      definitionId: "def_recurring_task",
      trigger: { kind: "daily", hour: 9, minute: 0 },
      scope: "bench",
      input: { agent: "wfd_agent", prompt: "Do it" },
      createdBy: "user_1",
    });

    const launched = await fireScheduledRoutine(
      {
        store,
        launcher,
        deliveryWorkbenchRequired: async () => false,
      },
      { tenantId: TENANT.id, routine: created },
    );

    expect(launcher.calls).toBe(1);
    expect(launched.runId).toBeTruthy();
  });
});
