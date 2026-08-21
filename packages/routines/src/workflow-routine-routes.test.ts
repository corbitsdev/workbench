// Route-level tests for Myra's own workflow-run-authenticated routine
// surface: authentication, tenant-scoped (not self-definition-scoped)
// create/list/update/run-now, and the deliverySpace auto-provision
// fallback. Mirrors `packages/agent-directory/test/workflow-capability-routes.test.ts`'s
// auth-check shape and `./test/routes.test.ts`'s fakes for the tenant-
// session routine route this surface parallels.
import { expect, test } from "bun:test";
import { Hono } from "hono";

import {
  createWorkflowRoutineRoutes,
  type CreateWorkflowRoutineRoutesDeps,
  type WorkflowRoutineRunScope,
  type WorkflowRunAuthenticator,
} from "./workflow-routine-routes";
import { createInMemoryRoutineStore, type RoutineStore } from "./store";
import type {
  WorkbenchNoticePort,
  DeliverySpacePort,
  RoutineLauncher,
} from "./routes";

const TENANT_ID = "tnt_1";
const PRINCIPAL_ID = "prn_myra";
const RUN_ID = "run_1";
const SIDECAR_TOKEN = "sidecar-token";
const RUN_ADDRESS = `${RUN_ID}@example.com`;

const authenticateAsMyra: WorkflowRunAuthenticator = {
  resolve: (token, address) =>
    Promise.resolve(
      token === SIDECAR_TOKEN && address === RUN_ADDRESS
        ? ({
            tenantId: TENANT_ID,
            principalId: PRINCIPAL_ID,
            runId: RUN_ID,
          } satisfies WorkflowRoutineRunScope)
        : null,
    ),
};

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

/** A store that always creates a routine already disabled — see the
 * identical helper in `./test/routes.test.ts` for why. */
function storeCreatingDisabled(): RoutineStore {
  const inner = createInMemoryRoutineStore();
  return {
    ...inner,
    async createRoutine(input) {
      const row = await inner.createRoutine(input);
      return inner.updateRoutine(input.tenantId, row.id, { enabled: false });
    },
  };
}

function buildApp(deps: CreateWorkflowRoutineRoutesDeps): Hono {
  return createWorkflowRoutineRoutes(deps) as unknown as Hono;
}

function buildDeps(
  overrides: Partial<CreateWorkflowRoutineRoutesDeps> = {},
): CreateWorkflowRoutineRoutesDeps {
  return {
    store: createInMemoryRoutineStore(),
    launcher: fakeLauncher(),
    authenticator: authenticateAsMyra,
    ...overrides,
  };
}

const AUTH_HEADERS = {
  authorization: `Bearer ${SIDECAR_TOKEN}`,
  "x-workflow-run-address": RUN_ADDRESS,
};

const VALID_BODY = {
  name: "Morning digest",
  definitionId: "def_digest",
  trigger: { kind: "daily", hour: 9, minute: 0 },
  deliveryWorkbenchId: "ch_delivery",
};

async function createRoutine(
  app: Hono,
  body: Record<string, unknown>,
  headers: Record<string, string> = AUTH_HEADERS,
) {
  const response = await app.request("/routines", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

test("a missing or unrecognized bearer token / run address is a 401", async () => {
  const app = buildApp(buildDeps());
  const { response } = await createRoutine(app, VALID_BODY, {});
  expect(response.status).toBe(401);
});

test("GET /routines is a 401 without a recognized run credential", async () => {
  const app = buildApp(buildDeps());
  const response = await app.request("/routines");
  expect(response.status).toBe(401);
});

test("creates a routine scoped 'bench', never a raw id where a name belongs", async () => {
  const app = buildApp(buildDeps());
  const { response, body } = await createRoutine(app, VALID_BODY);
  expect(response.status).toBe(201);
  expect(body["name"]).toBe("Morning digest");
  expect(body["scope"]).toBe("bench");
  expect(body["trigger"]).toEqual({ kind: "daily", hour: 9, minute: 0 });
  expect(typeof body["id"]).toBe("string");
});

test("creates a routine targeting a definition other than Myra's own — tenant-scoped, not self-definition-scoped", async () => {
  const deps = buildDeps({
    definitionInTenant: async (tenantId, definitionId) =>
      tenantId === TENANT_ID && definitionId === "def_some_other_agent",
  });
  const app = buildApp(deps);
  const { response } = await createRoutine(app, {
    ...VALID_BODY,
    definitionId: "def_some_other_agent",
  });
  expect(response.status).toBe(201);
});

test("rejects a definition that is not in the run's own tenant", async () => {
  const deps = buildDeps({ definitionInTenant: async () => false });
  const app = buildApp(deps);
  const { response, body } = await createRoutine(app, VALID_BODY);
  expect(response.status).toBe(404);
  expect((body["error"] as Record<string, unknown>)["code"]).toBe("not_found");
});

test("resolves a definition NAME to its id via resolveDefinitionId and stores the resolved id", async () => {
  const deps = buildDeps({
    definitionInTenant: async (tenantId, definitionId) =>
      tenantId === TENANT_ID && definitionId === "wfd_digest",
    resolveDefinitionId: async (tenantId, idOrName) =>
      tenantId === TENANT_ID && idOrName === "digest-writer"
        ? "wfd_digest"
        : undefined,
  });
  const app = buildApp(deps);
  const { response, body } = await createRoutine(app, {
    ...VALID_BODY,
    definitionId: "digest-writer",
  });
  expect(response.status).toBe(201);
  expect(body["definitionId"]).toBe("wfd_digest");
});

test("an unresolvable definitionId 404s with up to 8 candidate name (wfd_id) pairs", async () => {
  const deps = buildDeps({
    definitionInTenant: async () => false,
    resolveDefinitionId: async () => undefined,
    listDefinitionCandidates: async () => [
      { id: "wfd_digest", name: "digest-writer" },
      { id: "wfd_other", name: "other-agent" },
    ],
  });
  const app = buildApp(deps);
  const { response, body } = await createRoutine(app, {
    ...VALID_BODY,
    definitionId: "nonexistent",
  });
  expect(response.status).toBe(404);
  const message = (body["error"] as Record<string, unknown>)[
    "message"
  ] as string;
  expect(message).toContain("digest-writer (wfd_digest)");
  expect(message).toContain("other-agent (wfd_other)");
});

test("an ambiguous name resolves to undefined and 404s", async () => {
  const deps = buildDeps({
    definitionInTenant: async () => false,
    resolveDefinitionId: async () => undefined,
  });
  const app = buildApp(deps);
  const { response } = await createRoutine(app, {
    ...VALID_BODY,
    definitionId: "digest-writer",
  });
  expect(response.status).toBe(404);
});

test("rejects an invalid trigger with a 400", async () => {
  const app = buildApp(buildDeps());
  const { response } = await createRoutine(app, {
    ...VALID_BODY,
    trigger: { kind: "daily", hour: 24, minute: 0 },
  });
  expect(response.status).toBe(400);
});

test("400s when delivery is required, no workbench is named, and no deliverySpace is wired", async () => {
  const app = buildApp(
    buildDeps({ deliveryWorkbenchRequired: async () => true }),
  );
  const { response } = await createRoutine(app, {
    ...VALID_BODY,
    deliveryWorkbenchId: undefined,
  });
  expect(response.status).toBe(400);
});

test("auto-provisions a delivery space via deliverySpace + resolveTenantDomain when none is named", async () => {
  let seenInput: Record<string, unknown> | undefined;
  const deliverySpace: DeliverySpacePort = {
    createDeliverySpace: (input) => {
      seenInput = input;
      return Promise.resolve({
        workbenchId: "ch_provisioned",
        compensate: () => Promise.resolve(),
      });
    },
  };
  const deps = buildDeps({
    deliveryWorkbenchRequired: async () => true,
    deliverySpace,
    resolveTenantDomain: async () => "acme.example",
  });
  const app = buildApp(deps);
  const { response, body } = await createRoutine(app, {
    ...VALID_BODY,
    deliveryWorkbenchId: undefined,
  });
  expect(response.status).toBe(201);
  expect(body["deliveryWorkbenchId"]).toBe("ch_provisioned");
  expect(seenInput).toEqual({
    tenantId: TENANT_ID,
    tenantDomain: "acme.example",
    creatorPrincipalId: PRINCIPAL_ID,
    creatorUserId: RUN_ID,
    name: "Morning digest",
  });
});

test("delivery defaults to the creating run's own workbench — no new space is provisioned", async () => {
  let provisioned = false;
  const deliverySpace: DeliverySpacePort = {
    createDeliverySpace: () => {
      provisioned = true;
      return Promise.resolve({
        workbenchId: "ch_provisioned",
        compensate: () => Promise.resolve(),
      });
    },
  };
  const deps = buildDeps({
    deliveryWorkbenchRequired: async () => true,
    deliverySpace,
    resolveTenantDomain: async () => "acme.example",
    resolveRunWorkbench: async (tenantId, runId) =>
      tenantId === TENANT_ID && runId === RUN_ID ? "ch_home" : undefined,
  });
  const app = buildApp(deps);
  const { response, body } = await createRoutine(app, {
    ...VALID_BODY,
    deliveryWorkbenchId: undefined,
  });
  expect(response.status).toBe(201);
  expect(body["deliveryWorkbenchId"]).toBe("ch_home");
  expect(provisioned).toBe(false);
});

test("a run with no home workbench still auto-provisions a delivery space", async () => {
  const deliverySpace: DeliverySpacePort = {
    createDeliverySpace: () =>
      Promise.resolve({
        workbenchId: "ch_provisioned",
        compensate: () => Promise.resolve(),
      }),
  };
  const deps = buildDeps({
    deliveryWorkbenchRequired: async () => true,
    deliverySpace,
    resolveTenantDomain: async () => "acme.example",
    resolveRunWorkbench: async () => undefined,
  });
  const app = buildApp(deps);
  const { response, body } = await createRoutine(app, {
    ...VALID_BODY,
    deliveryWorkbenchId: undefined,
  });
  expect(response.status).toBe(201);
  expect(body["deliveryWorkbenchId"]).toBe("ch_provisioned");
});

test("an explicit deliveryWorkbenchId always wins over the run's home workbench", async () => {
  const deps = buildDeps({
    deliveryWorkbenchRequired: async () => true,
    resolveRunWorkbench: async () => "ch_home",
  });
  const app = buildApp(deps);
  const { response, body } = await createRoutine(app, {
    ...VALID_BODY,
    deliveryWorkbenchId: "ch_named",
  });
  expect(response.status).toBe(201);
  expect(body["deliveryWorkbenchId"]).toBe("ch_named");
});

test("runOnceNow launches immediately through the same launcher run-now uses", async () => {
  const launcher = fakeLauncher();
  const app = buildApp(buildDeps({ launcher }));
  const { response } = await createRoutine(app, {
    ...VALID_BODY,
    runOnceNow: true,
  });
  expect(response.status).toBe(201);
  expect(launcher.calls).toBe(1);
});

test("GET /routines lists this tenant's routines only", async () => {
  const store = createInMemoryRoutineStore();
  await store.createRoutine({
    tenantId: TENANT_ID,
    name: "Mine",
    definitionId: "def_1",
    trigger: null,
    scope: "bench",
    input: {},
    createdBy: PRINCIPAL_ID,
  });
  await store.createRoutine({
    tenantId: "tnt_other",
    name: "Not mine",
    definitionId: "def_1",
    trigger: null,
    scope: "bench",
    input: {},
    createdBy: "prn_other",
  });
  const app = buildApp(buildDeps({ store }));
  const response = await app.request("/routines", { headers: AUTH_HEADERS });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: { name: string }[] };
  expect(body.items.map((item) => item.name)).toEqual(["Mine"]);
});

test("PATCH /routines/:id updates enabled, name, trigger, and input", async () => {
  const app = buildApp(buildDeps());
  const { body: created } = await createRoutine(app, VALID_BODY);
  const response = await app.request(`/routines/${String(created["id"])}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      enabled: false,
      name: "Evening digest",
      trigger: { kind: "daily", hour: 18, minute: 30 },
      input: { instruction: "Summarize today's threads" },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body["enabled"]).toBe(false);
  expect(body["name"]).toBe("Evening digest");
  expect(body["trigger"]).toEqual({ kind: "daily", hour: 18, minute: 30 });
  expect(body["input"]).toEqual({ instruction: "Summarize today's threads" });
});

test("POST /routines posts an honest notice when created enabled", async () => {
  const workbenchNotice = fakeWorkbenchNotice();
  const app = buildApp(buildDeps({ workbenchNotice }));
  await createRoutine(app, VALID_BODY);

  expect(workbenchNotice.calls.length).toBe(1);
  expect(workbenchNotice.calls[0]?.workbenchId).toBe(
    VALID_BODY.deliveryWorkbenchId,
  );
  expect(workbenchNotice.calls[0]?.text).toBe(
    'Created routine "Morning digest" — At 09:00 (UTC). ' +
      "Manage it from Routines.",
  );
});

test("POST /routines posts nothing when created disabled", async () => {
  const workbenchNotice = fakeWorkbenchNotice();
  const app = buildApp(
    buildDeps({ workbenchNotice, store: storeCreatingDisabled() }),
  );
  const { response } = await createRoutine(app, VALID_BODY);

  expect(response.status).toBe(201);
  expect(workbenchNotice.calls.length).toBe(0);
});

test("PATCH /routines/:id posts an honest notice when flipped to enabled", async () => {
  const workbenchNotice = fakeWorkbenchNotice();
  const store = storeCreatingDisabled();
  const app = buildApp(buildDeps({ workbenchNotice, store }));
  const { body: created } = await createRoutine(app, VALID_BODY);

  const response = await app.request(`/routines/${String(created["id"])}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ enabled: true }),
  });

  expect(response.status).toBe(200);
  expect(workbenchNotice.calls.length).toBe(1);
  expect(workbenchNotice.calls[0]?.text).toBe(
    'Enabled routine "Morning digest" — At 09:00 (UTC). ' +
      "Manage it from Routines.",
  );
});

test("PATCH /routines/:id posts nothing for an update that does not flip enabled", async () => {
  const workbenchNotice = fakeWorkbenchNotice();
  const app = buildApp(buildDeps({ workbenchNotice }));
  const { body: created } = await createRoutine(app, VALID_BODY);
  workbenchNotice.calls.length = 0; // clear the create notice

  const response = await app.request(`/routines/${String(created["id"])}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ name: "Renamed digest" }),
  });

  expect(response.status).toBe(200);
  expect(workbenchNotice.calls.length).toBe(0);
});

test("PATCH /routines/:id 404s for a routine outside the run's own tenant", async () => {
  const store = createInMemoryRoutineStore();
  const other = await store.createRoutine({
    tenantId: "tnt_other",
    name: "Not mine",
    definitionId: "def_1",
    trigger: null,
    scope: "bench",
    input: {},
    createdBy: "prn_other",
  });
  const app = buildApp(buildDeps({ store }));
  const response = await app.request(`/routines/${other.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ enabled: false }),
  });
  expect(response.status).toBe(404);
});

test("POST /routines/:id/run launches now through the shared launch-and-correlate path", async () => {
  const launcher = fakeLauncher();
  const app = buildApp(buildDeps({ launcher }));
  const { body: created } = await createRoutine(app, VALID_BODY);
  const response = await app.request(`/routines/${String(created["id"])}/run`, {
    method: "POST",
    headers: AUTH_HEADERS,
  });
  expect(response.status).toBe(201);
  expect(launcher.calls).toBe(1);
  const body = (await response.json()) as { runId: string };
  expect(typeof body.runId).toBe("string");
});

test("POST /routines/:id/run 404s for an unknown routine id", async () => {
  const app = buildApp(buildDeps());
  const response = await app.request("/routines/does-not-exist/run", {
    method: "POST",
    headers: AUTH_HEADERS,
  });
  expect(response.status).toBe(404);
});
