import { describe, expect, it, mock } from "bun:test";
import type { CryptoProvider } from "@intx/types/runtime";
import type {
  RepoStore,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";

// Mock the user-context resolver: the routes call getRequestedUserContext(db,
// userId, tenantId) and gate on its result. forbidden=true → 403; a non-null
// context lets the ancestor-walk ownership checks run.
type RequestedResult = {
  context: { tenantId: string; principalId: string } | null;
  forbidden: boolean;
};
let userContextImpl: () => Promise<RequestedResult> = () =>
  Promise.resolve({
    context: { tenantId: "tenant-1", principalId: "principal-1" },
    forbidden: false,
  });
mock.module("../lib/user-context", () => ({
  getRequestedUserContext: () => userContextImpl(),
}));

// The routes walk the active tenant -> ancestors chain via getAncestorChain
// (most-specific first). Default: workbench shadows the global root.
let ancestorChain: string[] = ["tenant-1", "tenant-global"];
const intxDbReal = await import("@intx/db");
mock.module("@intx/db", () => ({
  ...intxDbReal,
  getAncestorChain: () => Promise.resolve(ancestorChain),
}));

// subscribeKind yields the run's on-disk event entries. The endpoint replays
// from seq 0 to find the StepCompleted for the requested step. We mock it at
// the @intx/hub-sessions boundary with a crafted async generator.
type FakeEntry = { seq: number; runId: string; event: Record<string, unknown> };
let subscribeKindEntries: FakeEntry[] = [];
let subscribeKindThrows: Error | null = null;

// createWorkflowRunBlobSubstrate yields a BlobSubstrate; we stub resolveRef to
// map crafted refs to values, asserting the endpoint resolves the right ref.
let resolveRefImpl: (ref: string) => Promise<unknown> = (ref) =>
  Promise.reject(new Error(`unexpected ref ${ref}`));

// Captures the repoId the endpoint subscribes the run-event log under, so a
// test can assert the hub reads under the SLUGGED workflow-run repo id the
// sidecar writes (not the raw `ses_<id>` deploymentId) — the id-mismatch that
// left every run's event log appearing empty.
//
// A container (not a bare `let`) so the test's read after `await getOutput(...)`
// is not narrowed by control-flow analysis to the `null` it was reset to — TS
// cannot see the async-generator mutation, but it does invalidate property
// narrowing across the intervening call.
const subscribeCapture: { repoId: { kind: string; id: string } | null } = {
  repoId: null,
};
const intxHubSessionsReal = await import("@intx/hub-sessions");
mock.module("@intx/hub-sessions", () => ({
  ...intxHubSessionsReal,
  subscribeKind: async function* (
    _store: unknown,
    _principal: unknown,
    repoId: { kind: string; id: string },
  ) {
    subscribeCapture.repoId = repoId;
    if (subscribeKindThrows) throw subscribeKindThrows;
    for (const entry of subscribeKindEntries) {
      yield entry;
    }
  },
}));

mock.module("@intx/workflow-host", () => ({
  createWorkflowRunBlobSubstrate: () => ({
    ephemeral: false,
    recordOutput: () => Promise.reject(new Error("not implemented")),
    resolveRef: (ref: string) => resolveRefImpl(ref),
  }),
}));

import { Hono } from "hono";
import {
  createWorkflowRunsRouter,
  deriveWorkflowRunRepoId,
  type EnsureDeploymentRoutableFn,
} from "./workflow-runs";
import type { HubDb } from "../db";
import { createWorkflowRunStarter } from "../services/workflow-run-starter";

type WorkflowRunRow = {
  deploymentId: string;
  kind: string;
  status: string;
  createdAt: string;
  tenantId: string;
};

// Captured update calls from the PATCH /status route.
const updateCapture: { deploymentId: string; status: string }[] = [];

function makeDb(owned: boolean) {
  const findFirst = mock(() =>
    Promise.resolve(
      owned ? { deploymentId: "dep-1", tenantId: "tenant-1" } : undefined,
    ),
  );
  const setMock = mock((values: { status: string }) => ({
    where: (cond: unknown) => {
      updateCapture.push({ deploymentId: "dep-1", status: values.status });
      void cond;
      return Promise.resolve();
    },
  }));
  return {
    query: {
      workflowRun: {
        findFirst,
      },
      // No member-role policy → the CL-2885 run gate allows (default).
      role: { findMany: mock(() => Promise.resolve([])) },
    },
    update: () => ({ set: setMock }),
  } as unknown as HubDb;
}

// A db whose LIST select() returns the given rows verbatim and whose findMany
// (start route) returns the given candidates. The route applies its own
// ancestor-chain filtering on top of `findMany` (shadowing); the LIST route
// trusts the rows the query returns.
function makeListDb(
  rows: WorkflowRunRow[],
  findManyRows: WorkflowRunRow[] = rows,
) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
    query: {
      workflowRun: {
        findMany: mock(() => Promise.resolve(findManyRows)),
      },
      role: { findMany: mock(() => Promise.resolve([])) },
    },
  } as unknown as HubDb;
}

const noopRepoStore = {} as unknown as RepoStore;
const noopSessionService = {} as unknown as SessionService;
const noopSidecarRouter = {} as unknown as SidecarRouter;
const noopCrypto = {} as unknown as CryptoProvider;

function buildApp(db: HubDb, userId = "user-1") {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  parent.route(
    "/",
    createWorkflowRunsRouter({
      db,
      repoStore: noopRepoStore,
      sidecarRouter: noopSidecarRouter,
      sessionService: noopSessionService,
      cryptoProvider: noopCrypto,
      deploymentDomain: "deploy.example.com",
      ensureDeploymentRoutable: () => Promise.resolve({ reestablished: false }),
      runStarter: createWorkflowRunStarter({
        db,
        sessionService: noopSessionService,
        ensureDeploymentRoutable: () =>
          Promise.resolve({ reestablished: false }),
        deploymentDomain: "deploy.example.com",
        cryptoProvider: noopCrypto,
      }),
    }),
  );
  return parent;
}

function getOutput(
  app: Hono<{ Variables: { userId: string } }>,
  dep: string,
  step: string,
) {
  return app.request(
    new Request(`http://local/workflow-runs/${dep}/steps/${step}/output`, {
      method: "GET",
    }),
  );
}

describe("deriveWorkflowRunRepoId", () => {
  it("slugifies the deployment mail address the way the sidecar keys the run repo", () => {
    // Must match apps/sidecar/src/workflow-host-wiring.ts deriveTrivialDeploymentId
    // applied to deriveDeploymentAddress(`ins_<deploymentId>@<domain>`): every
    // character outside /[a-zA-Z0-9_-]/ becomes `-`.
    expect(
      deriveWorkflowRunRepoId({
        deploymentId: "ses_e47abe56e772d99a71e794b8f8e73a2f",
        deploymentDomain: "abklabs.com",
      }),
    ).toBe("ins_ses_e47abe56e772d99a71e794b8f8e73a2f-abklabs-com");
  });

  it("produces a substrate-safe id (no @ or . survive)", () => {
    const id = deriveWorkflowRunRepoId({
      deploymentId: "ses_abc",
      deploymentDomain: "deploy.example.com",
    });
    expect(id).toBe("ins_ses_abc-deploy-example-com");
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("GET /workflow-runs/:deploymentId/steps/:stepId/output", () => {
  it("subscribes the run-event log under the slugged repo id, not the raw deploymentId", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [];
    subscribeCapture.repoId = null;

    // 404 (step never completes) is fine; we only assert WHICH repo id the
    // endpoint read from. The raw param is `dep-1`; the sidecar writes under
    // the slug of `ins_dep-1@deploy.example.com`.
    await getOutput(buildApp(makeDb(true)), "dep-1", "step-a");
    // Read through a typed getter so control-flow analysis does not narrow the
    // capture back to the `null` it was reset to before the call.
    const captured = (): { kind: string; id: string } | null =>
      subscribeCapture.repoId;
    expect(captured()).toEqual({
      kind: "workflow-run",
      id: "ins_dep-1-deploy-example-com",
    });
  });

  it("resolves an inline ref to the step output content", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: "run-1", event: { type: "RunStarted", seq: 0 } },
      {
        seq: 1,
        runId: "run-1",
        event: {
          type: "StepCompleted",
          seq: 1,
          stepId: "step-a",
          output: { ref: 'inline:{"x":1}' },
        },
      },
    ];
    resolveRefImpl = (ref) => {
      expect(ref).toBe('inline:{"x":1}');
      return Promise.resolve({ x: 1 });
    };

    const res = await getOutput(buildApp(makeDb(true)), "dep-1", "step-a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stepId: "step-a", output: { x: 1 } });
  });

  it("resolves a blob ref to the step output content", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: "run-9", event: { type: "RunStarted", seq: 0 } },
      {
        seq: 2,
        runId: "run-9",
        event: {
          type: "StepCompleted",
          seq: 2,
          stepId: "step-b",
          output: { ref: "blob:abc123" },
        },
      },
    ];
    const big = { payload: "large" };
    resolveRefImpl = (ref) => {
      expect(ref).toBe("blob:abc123");
      return Promise.resolve(big);
    };

    const res = await getOutput(buildApp(makeDb(true)), "dep-1", "step-b");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stepId: "step-b", output: big });
  });

  it("404s for a deployment the caller does not own", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    const res = await getOutput(buildApp(makeDb(false)), "dep-x", "step-a");
    expect(res.status).toBe(404);
  });

  it("404s when the requested step has not completed", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: "run-1", event: { type: "RunStarted", seq: 0 } },
      {
        seq: 1,
        runId: "run-1",
        event: {
          type: "StepCompleted",
          seq: 1,
          stepId: "other-step",
          output: { ref: "inline:1" },
        },
      },
    ];
    const res = await getOutput(buildApp(makeDb(true)), "dep-1", "step-a");
    expect(res.status).toBe(404);
  });

  it("403s when there is no user context", async () => {
    userContextImpl = () =>
      Promise.resolve({ context: null, forbidden: false });
    const res = await getOutput(buildApp(makeDb(true)), "dep-1", "step-a");
    expect(res.status).toBe(403);
  });

  it("500s when ref resolution fails", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      {
        seq: 1,
        runId: "run-1",
        event: {
          type: "StepCompleted",
          seq: 1,
          stepId: "step-a",
          output: { ref: "inline:bad" },
        },
      },
    ];
    resolveRefImpl = () => Promise.reject(new Error("boom"));
    const res = await getOutput(buildApp(makeDb(true)), "dep-1", "step-a");
    expect(res.status).toBe(500);
  });
});

describe("GET /workflow-runs (workbench-aware visibility)", () => {
  function listApp(db: HubDb) {
    const parent = new Hono<{ Variables: { userId: string } }>();
    parent.use("*", async (c, next) => {
      c.set("userId", "user-1");
      await next();
    });
    parent.route(
      "/",
      createWorkflowRunsRouter({
        db,
        repoStore: noopRepoStore,
        sidecarRouter: noopSidecarRouter,
        sessionService: noopSessionService,
        cryptoProvider: noopCrypto,
        deploymentDomain: "deploy.example.com",
        ensureDeploymentRoutable: () =>
          Promise.resolve({ reestablished: false }),
        runStarter: createWorkflowRunStarter({
          db,
          sessionService: noopSessionService,
          ensureDeploymentRoutable: () =>
            Promise.resolve({ reestablished: false }),
          deploymentDomain: "deploy.example.com",
          cryptoProvider: noopCrypto,
        }),
      }),
    );
    return parent;
  }

  it("lists the active workbench deployments plus global-inherited ones", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    ancestorChain = ["tenant-1", "tenant-global"];
    const rows: WorkflowRunRow[] = [
      {
        deploymentId: "dep-wb",
        kind: "deck",
        status: "idle",
        createdAt: "2026-06-01T00:00:00.000Z",
        tenantId: "tenant-1",
      },
      {
        deploymentId: "dep-global",
        kind: "report",
        status: "idle",
        createdAt: "2026-05-01T00:00:00.000Z",
        tenantId: "tenant-global",
      },
    ];
    const res = await listApp(makeListDb(rows)).request(
      new Request("http://local/workflow-runs?tenantId=tenant-1", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploymentId: string }[];
    expect(body.map((r) => r.deploymentId).sort()).toEqual([
      "dep-global",
      "dep-wb",
    ]);
  });

  it("omits deployments whose kind is denied by the member run gate", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    ancestorChain = ["tenant-1"];
    const rows: WorkflowRunRow[] = [
      {
        deploymentId: "dep-wb",
        kind: "deck",
        status: "idle",
        createdAt: "2026-06-01T00:00:00.000Z",
        tenantId: "tenant-1",
      },
      {
        deploymentId: "dep-other",
        kind: "report",
        status: "idle",
        createdAt: "2026-06-05T00:00:00.000Z",
        tenantId: "tenant-1",
      },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(rows),
          }),
        }),
      }),
      query: {
        workflowRun: { findMany: mock(() => Promise.resolve(rows)) },
        role: {
          findMany: mock(() => Promise.resolve([{ id: "rol_member" }])),
        },
        grant: {
          findMany: mock(() =>
            Promise.resolve([
              {
                id: "grt_1",
                resource: "workflow:deck",
                action: "run",
                effect: "deny",
                origin: "role",
                conditions: null,
                expiresAt: null,
                roleId: "rol_member",
                principalId: null,
              },
            ]),
          ),
        },
      },
    } as unknown as HubDb;
    const res = await listApp(db).request(
      new Request("http://local/workflow-runs?tenantId=tenant-1", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string }[];
    expect(body.map((r) => r.kind)).toEqual(["report"]);
  });

  it("403s when the caller is not a principal of the requested tenant", async () => {
    userContextImpl = () => Promise.resolve({ context: null, forbidden: true });
    const res = await listApp(makeListDb([])).request(
      new Request("http://local/workflow-runs?tenantId=tenant-other", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /workflow-runs/:kind/start (shadowing + visibility)", () => {
  function startApp(
    db: HubDb,
    capture: { msg?: { tenantId: string } },
    ensure?: EnsureDeploymentRoutableFn,
  ) {
    const sessionService = {
      sendUserMessage: (args: { tenantId: string }) => {
        capture.msg = args;
        return Promise.resolve();
      },
    } as unknown as SessionService;
    const parent = new Hono<{ Variables: { userId: string } }>();
    parent.use("*", async (c, next) => {
      c.set("userId", "user-1");
      await next();
    });
    parent.route(
      "/",
      createWorkflowRunsRouter({
        db,
        repoStore: noopRepoStore,
        sidecarRouter: noopSidecarRouter,
        sessionService,
        cryptoProvider: noopCrypto,
        deploymentDomain: "deploy.example.com",
        ensureDeploymentRoutable:
          ensure ?? (() => Promise.resolve({ reestablished: false })),
        runStarter: createWorkflowRunStarter({
          db,
          sessionService,
          ensureDeploymentRoutable:
            ensure ?? (() => Promise.resolve({ reestablished: false })),
          deploymentDomain: "deploy.example.com",
          cryptoProvider: noopCrypto,
        }),
      }),
    );
    return parent;
  }

  it("re-establishes the supervisor before delivering, and does not deliver if that fails", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    ancestorChain = ["tenant-1"];
    const candidates: WorkflowRunRow[] = [
      {
        deploymentId: "dep-wb",
        kind: "deck",
        status: "idle",
        createdAt: "2026-06-01T00:00:00.000Z",
        tenantId: "tenant-1",
      },
    ];
    const ensureArgs: { deploymentId: string; kind: string }[] = [];
    const ensure: EnsureDeploymentRoutableFn = (args) => {
      ensureArgs.push({ deploymentId: args.deploymentId, kind: args.kind });
      return Promise.reject(new Error("sidecar down"));
    };
    const capture: { msg?: { tenantId: string } } = {};
    const res = await startApp(
      makeListDb([], candidates),
      capture,
      ensure,
    ).request(
      new Request("http://local/workflow-runs/deck/start?tenantId=tenant-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foo: "bar" }),
      }),
    );
    expect(res.status).toBe(500);
    // ensure was invoked with the resolved deployment's identity...
    expect(ensureArgs).toEqual([{ deploymentId: "dep-wb", kind: "deck" }]);
    // ...and the trigger was NOT delivered because re-establishment failed.
    expect(capture.msg).toBeUndefined();
  });

  it("the most-specific tenant deployment shadows an inherited global one", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    ancestorChain = ["tenant-1", "tenant-global"];
    const candidates: WorkflowRunRow[] = [
      {
        deploymentId: "dep-global",
        kind: "deck",
        status: "idle",
        createdAt: "2026-06-10T00:00:00.000Z",
        tenantId: "tenant-global",
      },
      {
        deploymentId: "dep-wb",
        kind: "deck",
        status: "idle",
        createdAt: "2026-06-01T00:00:00.000Z",
        tenantId: "tenant-1",
      },
    ];
    const capture: { msg?: { tenantId: string } } = {};
    const res = await startApp(makeListDb([], candidates), capture).request(
      new Request("http://local/workflow-runs/deck/start?tenantId=tenant-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foo: "bar" }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { deploymentId: string };
    expect(body.deploymentId).toBe("dep-wb");
    expect(capture.msg?.tenantId).toBe("tenant-1");
  });

  it("starts the inherited global deployment when the workbench has none", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    ancestorChain = ["tenant-1", "tenant-global"];
    const candidates: WorkflowRunRow[] = [
      {
        deploymentId: "dep-global",
        kind: "deck",
        status: "idle",
        createdAt: "2026-06-10T00:00:00.000Z",
        tenantId: "tenant-global",
      },
    ];
    const capture: { msg?: { tenantId: string } } = {};
    const res = await startApp(makeListDb([], candidates), capture).request(
      new Request("http://local/workflow-runs/deck/start?tenantId=tenant-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(202);
    expect(capture.msg?.tenantId).toBe("tenant-global");
  });

  it("403s for a tenant the caller is not a principal of", async () => {
    userContextImpl = () => Promise.resolve({ context: null, forbidden: true });
    const capture: { msg?: { tenantId: string } } = {};
    const res = await startApp(makeListDb([], []), capture).request(
      new Request(
        "http://local/workflow-runs/deck/start?tenantId=tenant-other",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /workflow-runs/:deploymentId/steps (batched step outputs)", () => {
  function allSteps(app: ReturnType<typeof buildApp>, dep: string) {
    return app.request(
      new Request(`http://local/workflow-runs/${dep}/steps`, { method: "GET" }),
    );
  }

  it("replays the log once and returns all completed step outputs as a map", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: "run-1", event: { type: "RunStarted", seq: 0 } },
      {
        seq: 1,
        runId: "run-1",
        event: {
          type: "StepCompleted",
          seq: 1,
          stepId: "step-a",
          output: { ref: 'inline:{"a":1}' },
        },
      },
      {
        seq: 2,
        runId: "run-1",
        event: {
          type: "StepCompleted",
          seq: 2,
          stepId: "step-b",
          output: { ref: 'inline:{"b":2}' },
        },
      },
    ];
    resolveRefImpl = (ref) => {
      if (ref === 'inline:{"a":1}') return Promise.resolve({ a: 1 });
      if (ref === 'inline:{"b":2}') return Promise.resolve({ b: 2 });
      return Promise.reject(new Error(`unexpected ref: ${ref}`));
    };

    const res = await allSteps(buildApp(makeDb(true)), "dep-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outputs: Record<string, unknown> };
    expect(body.outputs).toEqual({ "step-a": { a: 1 }, "step-b": { b: 2 } });
  });

  it("returns an empty outputs map when no steps have completed", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    subscribeKindThrows = null;
    subscribeKindEntries = [
      { seq: 0, runId: "run-2", event: { type: "RunStarted", seq: 0 } },
    ];

    const res = await allSteps(buildApp(makeDb(true)), "dep-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outputs: Record<string, unknown> };
    expect(body.outputs).toEqual({});
  });

  it("404s for a deployment the caller does not own", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    const res = await allSteps(buildApp(makeDb(false)), "dep-x");
    expect(res.status).toBe(404);
  });

  it("403s when there is no user context", async () => {
    userContextImpl = () =>
      Promise.resolve({ context: null, forbidden: false });
    const res = await allSteps(buildApp(makeDb(true)), "dep-1");
    expect(res.status).toBe(403);
  });

  it("500s when the event log replay throws", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    subscribeKindThrows = new Error("log unavailable");
    subscribeKindEntries = [];

    const res = await allSteps(buildApp(makeDb(true)), "dep-1");
    expect(res.status).toBe(500);
  });
});

// CL-2727: the FE-driven optimistic status write is GONE. The projection bridge
// (and the hub liveness sweep) are the sole writers of run status. The former
// PATCH /workflow-runs/:deploymentId/status route — which the FE called on a
// terminal SSE event to write workflow_run.status directly — must no longer
// exist, so the FE can no longer write status. An unmatched route 404s.
describe("PATCH /workflow-runs/:deploymentId/status is removed (CL-2727)", () => {
  it("404s — the client can no longer write run status", async () => {
    userContextImpl = () =>
      Promise.resolve({
        context: { tenantId: "tenant-1", principalId: "p-1" },
        forbidden: false,
      });
    updateCapture.length = 0;
    const res = await buildApp(makeDb(true)).request(
      new Request("http://local/workflow-runs/dep-1/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      }),
    );
    expect(res.status).toBe(404);
    // And nothing was written.
    expect(updateCapture).toEqual([]);
  });
});
