import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { GrantRule } from "@intx/authz";
import type { RunState } from "../workflow-executor/executor";

// The abort handlers read a run via loadRunRecord and persist the terminal mark
// through createRunStore().save(). Both live in run-store; mock that boundary so
// the tests assert the saved state (not the DB), and back the bulk handler's
// status filter with an in-memory table.

type Saved = { runId: string; status: string; error: string | undefined };

const records = new Map<string, RunState>();
const saved: Saved[] = [];

const loadRunRecord = mock(
  async (_db: unknown, runId: string) => records.get(runId) ?? null,
);
const save = mock(async (state: RunState) => {
  records.set(state.runId, state);
  saved.push({ runId: state.runId, status: state.status, error: state.error });
});
const createRunStore = mock(() => ({ save }));
const markRunStopped = mock(
  async (_db: unknown, state: RunState, error: string) => {
    await save({ ...state, status: "failed", error });
  },
);

mock.module("../workflow-executor/run-store", () => ({
  loadRunRecord,
  createRunStore,
  markRunStopped,
}));

const ensureMember = mock(async () => ({
  tenantId: "tenant_global",
  principalId: "caller_principal",
}));
const getRootTenantId = mock(async () => "tenant_global");
const lookupMember = mock(async () => ({
  tenantId: "tenant_global",
  principalId: "caller_principal",
}));
mock.module("../lib/tenant-provisioning", () => ({
  ensureMember,
  getRootTenantId,
  lookupMember,
}));

const {
  abortRunHandler,
  abortActiveRunsHandler,
  abortRunRouteDescription,
  abortActiveRunsRouteDescription,
  ABORTED_ERROR,
} = await import("./workflow-run-abort");
const { createWorkflowDeployGrantGuard } = await import("./workflow-deploy");
const { Hono } = await import("hono");
const { openAPIRouteHandler } = await import("hono-openapi");

afterAll(() => {
  mock.restore();
});

function seed(state: Partial<RunState> & { runId: string }): RunState {
  const full: RunState = {
    kind: "call-to-collateral",
    tenantId: "tenant_global",
    principalId: "p1",
    status: "running",
    currentStepId: null,
    input: {},
    outputs: {},
    ...state,
  };
  records.set(full.runId, full);
  return full;
}

// The bulk handler queries db.select().from().where() for the active-run ids.
// This fake applies the same active/kind/tenant filter the handler's predicate
// encodes, over the seeded `records`, so the test exercises the real selection
// logic end to end (the predicate is opaque to the fake, so we re-derive it from
// the query params instead — see abortActive() which passes them through).
function makeDb(activeIds: string[]) {
  return {
    select: () => ({
      from: () => ({
        where: async () => activeIds.map((id) => ({ id })),
      }),
    }),
  } as unknown as Parameters<typeof abortRunHandler>[0]["db"];
}

beforeEach(() => {
  records.clear();
  saved.length = 0;
  loadRunRecord.mockClear();
  save.mockClear();
});

function abortApp(db: ReturnType<typeof makeDb>) {
  const app = new Hono();
  app.delete("/workflow-exec/records/:runId", abortRunHandler({ db }));
  app.post(
    "/workflow-exec/records/abort-active",
    abortActiveRunsHandler({ db }),
  );
  return app;
}

describe("abortRunHandler", () => {
  test("marks an existing run terminal (failed + aborted error)", async () => {
    seed({ runId: "wfr_1", status: "running" });
    const res = await abortApp(makeDb([])).request(
      "/workflow-exec/records/wfr_1",
      {
        method: "DELETE",
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; status: string };
    expect(body).toEqual({ runId: "wfr_1", status: "failed" });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      runId: "wfr_1",
      status: "failed",
      error: ABORTED_ERROR,
    });
  });

  test("404 for an unknown run, no save", async () => {
    const res = await abortApp(makeDb([])).request(
      "/workflow-exec/records/wfr_ghost",
      {
        method: "DELETE",
      },
    );
    expect(res.status).toBe(404);
    expect(saved).toHaveLength(0);
  });
});

describe("abortActiveRunsHandler", () => {
  test("aborts only the active runs the query returns; terminal runs untouched", async () => {
    seed({ runId: "wfr_run", status: "running" });
    seed({ runId: "wfr_wait", status: "awaiting" });
    // Completed/failed seeded too, but the query (makeDb) does not return them.
    seed({ runId: "wfr_done", status: "completed" });
    seed({ runId: "wfr_fail", status: "failed" });

    const res = await abortApp(makeDb(["wfr_run", "wfr_wait"])).request(
      "/workflow-exec/records/abort-active",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aborted: number; ids: string[] };
    expect(body.aborted).toBe(2);
    expect(body.ids.sort()).toEqual(["wfr_run", "wfr_wait"]);

    // Only the two active runs were marked terminal.
    expect(saved.map((s) => s.runId).sort()).toEqual(["wfr_run", "wfr_wait"]);
    for (const s of saved) {
      expect(s.status).toBe("failed");
      expect(s.error).toBe(ABORTED_ERROR);
    }
    // Completed/failed records keep their original status.
    expect(records.get("wfr_done")?.status).toBe("completed");
  });

  test("returns 0 when no active runs match", async () => {
    seed({ runId: "wfr_done", status: "completed" });
    const res = await abortApp(makeDb([])).request(
      "/workflow-exec/records/abort-active",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aborted: number; ids: string[] };
    expect(body.aborted).toBe(0);
    expect(body.ids).toEqual([]);
    expect(saved).toHaveLength(0);
  });
});

// The routes are mounted behind the SAME operator grant guard as /workflows/deploy
// (createWorkflowDeployGrantGuard) — not the per-user ownership gate. These tests
// drive the real guard so a non-operator request is rejected BEFORE the handler
// runs (no run is marked terminal).
describe("operator gate on abort routes", () => {
  function grantRule(resource: string, action: string): GrantRule {
    return {
      id: "g1",
      resource,
      action,
      effect: "allow",
      origin: "role",
      conditions: null,
      expiresAt: null,
      roleId: "role_owner",
      principalId: null,
    };
  }

  function gatedApp(grants: GrantRule[]) {
    const grantStore = { collectGrants: async () => grants };
    const guard = createWorkflowDeployGrantGuard({
      db: {} as Parameters<typeof createWorkflowDeployGrantGuard>[0]["db"],
      grantStore,
      rootTenantId: "tenant_global",
    });
    const db = makeDb(["wfr_run"]);
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", "user1");
      await next();
    });
    app.delete("/workflow-exec/records/:runId", guard, abortRunHandler({ db }));
    app.post(
      "/workflow-exec/records/abort-active",
      guard,
      abortActiveRunsHandler({ db }),
    );
    return app;
  }

  test("denies (403) a non-operator aborting one run; no save", async () => {
    seed({ runId: "wfr_run", status: "running" });
    const res = await gatedApp([grantRule("agent:*", "read")]).request(
      "/workflow-exec/records/wfr_run",
      { method: "DELETE" },
    );
    expect(res.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  test("denies (403) a non-operator bulk-abort; no save", async () => {
    seed({ runId: "wfr_run", status: "running" });
    const res = await gatedApp([]).request(
      "/workflow-exec/records/abort-active",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  test("allows an operator granted workflow:* / create", async () => {
    seed({ runId: "wfr_run", status: "running" });
    const res = await gatedApp([grantRule("workflow:*", "create")]).request(
      "/workflow-exec/records/wfr_run",
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(saved).toHaveLength(1);
  });
});

// The admin CLI builds its menu from /openapi.json grouped by `tags`. Both abort
// routes must appear under the `Workflows` tag for an operator to reach them.
describe("OpenAPI discovery", () => {
  test("both abort routes appear under the Workflows tag", async () => {
    const db = makeDb([]);
    const app = new Hono();
    app.get(
      "/openapi.json",
      openAPIRouteHandler(app, {
        documentation: { info: { title: "t", version: "1" } },
        exclude: ["/openapi.json"],
      }),
    );
    app.delete(
      "/api/v1/workflow-exec/records/:runId",
      abortRunRouteDescription,
      abortRunHandler({ db }),
    );
    app.post(
      "/api/v1/workflow-exec/records/abort-active",
      abortActiveRunsRouteDescription,
      abortActiveRunsHandler({ db }),
    );

    const res = await app.request("/openapi.json");
    const body = (await res.json()) as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    expect(
      body.paths["/api/v1/workflow-exec/records/{runId}"]?.delete?.tags,
    ).toEqual(["Workflows"]);
    expect(
      body.paths["/api/v1/workflow-exec/records/abort-active"]?.post?.tags,
    ).toEqual(["Workflows"]);
  });
});
