import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { CryptoProvider } from "@intx/types/runtime";
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import type { RunState } from "../workflow-executor/executor";

// Override only getAncestorChain (the routes walk the tenant chain); preserve
// every other @intx/db export so sibling suites in the same process keep theirs.
const realDb = await import("@intx/db");
let ancestorChain: readonly string[] = ["tn-1"];
mock.module("@intx/db", () => ({
  ...realDb,
  getAncestorChain: async () => [...ancestorChain],
}));

// In-memory run-store: the row is the durable record the UI polls. insert seeds
// it at /start, save updates it (the optimistic resume flip, and what the
// projection bridge would do), load reads it back — including deploymentId, which
// resume needs to address the sidecar.
const runs = new Map<string, RunState>();
mock.module("../workflow-executor/run-store", () => ({
  createRunStore: () => ({
    save: async (state: RunState) => {
      runs.set(state.runId, structuredClone(state));
    },
  }),
  insertRunRecord: async (
    _db: unknown,
    args: {
      runId: string;
      deploymentId: string | null;
      kind: string;
      tenantId: string;
      principalId: string;
      input: unknown;
    },
  ) => {
    const state: RunState = {
      runId: args.runId,
      kind: args.kind,
      tenantId: args.tenantId,
      principalId: args.principalId,
      status: "running",
      currentStepId: null,
      input: args.input,
      outputs: {},
      ...(args.deploymentId !== null
        ? { deploymentId: args.deploymentId }
        : {}),
    };
    runs.set(state.runId, structuredClone(state));
    return state;
  },
  loadRunRecord: async (_db: unknown, runId: string) => {
    const found = runs.get(runId);
    return found ? structuredClone(found) : null;
  },
  listRunRecords: async (
    _db: unknown,
    _tenantIds: readonly string[],
    principalId: string,
    kind?: string,
  ) =>
    [...runs.values()]
      .filter((r) => r.principalId === principalId)
      .filter((r) => kind === undefined || r.kind === kind)
      .map((r) => ({
        runId: r.runId,
        kind: r.kind,
        status: r.status,
        createdAt: new Date(),
      })),
}));

const { createWorkflowRunRecordsRouter } = await import(
  "./workflow-run-records"
);

// Captured sidecar interactions, asserted per test.
const sentMessages: {
  agentAddress: string;
  messageId: string;
  content: string;
}[] = [];
const sentSignals: {
  agentAddress: string;
  runId: string;
  signalName: string;
  payload: unknown;
}[] = [];
const ensureCalls: { deploymentId: string; creatorPrincipalId: string }[] = [];
const provisionCalls: {
  kind: string;
  tenantId: string;
  creatorPrincipalId: string;
}[] = [];
let sendShouldThrow = false;
let provisionShouldThrow = false;

function resetCaptures(): void {
  runs.clear();
  sentMessages.length = 0;
  sentSignals.length = 0;
  ensureCalls.length = 0;
  provisionCalls.length = 0;
  sendShouldThrow = false;
  provisionShouldThrow = false;
}

const sessionService = {
  sendUserMessage: async (args: {
    agentAddress: string;
    messageId: string;
    content: string;
  }) => {
    if (sendShouldThrow) throw new Error("sidecar unreachable");
    sentMessages.push({
      agentAddress: args.agentAddress,
      messageId: args.messageId,
      content: args.content,
    });
  },
} as unknown as SessionService;

const sidecarRouter = {
  sendSignalDeliver: (args: {
    agentAddress: string;
    runId: string;
    signalName: string;
    payload: unknown;
  }) => {
    sentSignals.push({
      agentAddress: args.agentAddress,
      runId: args.runId,
      signalName: args.signalName,
      payload: args.payload,
    });
  },
} as unknown as SidecarRouter;

const ensureDeploymentRoutable = async (args: {
  deploymentId: string;
  creatorPrincipalId: string;
}) => {
  ensureCalls.push({
    deploymentId: args.deploymentId,
    creatorPrincipalId: args.creatorPrincipalId,
  });
  return { reestablished: false };
};

// Each call mints a fresh, single-use deployment id distinct from the shared
// registry row's `ses_dep1` — proving run-start deploys per run, not the shared
// deployment.
const provisionRunDeployment = async (args: {
  kind: string;
  tenantId: string;
  creatorPrincipalId: string;
}) => {
  if (provisionShouldThrow) throw new Error("deploy failed");
  provisionCalls.push({
    kind: args.kind,
    tenantId: args.tenantId,
    creatorPrincipalId: args.creatorPrincipalId,
  });
  return { deploymentId: `ses_run_${provisionCalls.length}` };
};

const DEFAULT_DEPLOYMENT = {
  deploymentId: "ses_dep1",
  tenantId: "tn-1",
  kind: "pain-point-collateral",
  principalId: "prn-deployer",
  createdAt: new Date(),
};

// biome-ignore lint/suspicious/noExplicitAny: structural test mock
type MockDb = any;
function makeDb(
  deployments: (typeof DEFAULT_DEPLOYMENT)[] = [DEFAULT_DEPLOYMENT],
): HubDb {
  const db: MockDb = {
    query: {
      workflowRun: {
        findMany: async () => deployments,
        findFirst: async () => deployments[0],
      },
    },
  };
  return db as HubDb;
}

function routerWith(opts: {
  db?: HubDb;
  context?: { tenantId: string; principalId: string };
}): Hono<{ Variables: { userId: string } }> {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  a.route(
    "/",
    createWorkflowRunRecordsRouter({
      db: opts.db ?? makeDb(),
      sidecarRouter,
      sessionService,
      cryptoProvider: {} as CryptoProvider,
      deploymentDomain: "wf.localhost",
      ensureDeploymentRoutable,
      provisionRunDeployment,
      resolveContext: async () => ({
        context: opts.context ?? { tenantId: "tn-1", principalId: "prn-1" },
        forbidden: false,
      }),
    }),
  );
  return a;
}

function app(): Hono<{ Variables: { userId: string } }> {
  return routerWith({});
}

function appAs(ctx: { tenantId: string; principalId: string }): Hono<{
  Variables: { userId: string };
}> {
  return routerWith({ context: ctx });
}

type AppHono = Hono<{ Variables: { userId: string } }>;

// biome-ignore lint/suspicious/noExplicitAny: test response shape
async function post(
  a: AppHono,
  path: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const res = await a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// biome-ignore lint/suspicious/noExplicitAny: test response shape
async function get(
  a: AppHono,
  path: string,
): Promise<{ status: number; json: any }> {
  const res = await a.request(path);
  return { status: res.status, json: await res.json() };
}

describe("workflow runs on the sidecar (records router)", () => {
  test("start provisions a FRESH per-run deployment from the definition and triggers IT, not the shared registry deployment (CL-2582)", async () => {
    resetCaptures();
    const a = app();
    const { status, json } = await post(
      a,
      "/workflow-exec/pain-point-collateral/start",
      {
        input: { topic: "Acme" },
      },
    );

    expect(status).toBe(200);
    expect(json.status).toBe("running");
    expect(json.currentStepId).toBeNull();
    expect(json.outputs).toEqual({});
    expect(typeof json.runId).toBe("string");

    // Provisioned once, into the DEFINITION's tenant + deploy principal (the
    // shared registry row), NOT the caller's principal.
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]).toEqual({
      kind: "pain-point-collateral",
      tenantId: "tn-1",
      creatorPrincipalId: "prn-deployer",
    });

    // The run runs on its OWN fresh deployment, never the shared `ses_dep1`.
    expect(json.deploymentId).toBe("ses_run_1");
    expect(json.deploymentId).not.toBe("ses_dep1");

    // The linchpin of the projection bridge: the trigger mail's messageId IS the
    // run record id, and it targets the fresh per-run deployment's address.
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.messageId).toBe(json.runId);
    expect(sentMessages[0]?.agentAddress).toBe("ins_ses_run_1@wf.localhost");
    expect(sentMessages[0]?.content).toBe(JSON.stringify({ topic: "Acme" }));

    // A freshly-deployed supervisor is routable by construction — the start path
    // no longer calls ensureDeploymentRoutable (that is the resume path's job).
    expect(ensureCalls).toHaveLength(0);
  });

  test("start returns 404 and provisions nothing when no workflow of the kind is deployed", async () => {
    resetCaptures();
    const a = routerWith({ db: makeDb([]) });
    const { status } = await post(
      a,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    expect(status).toBe(404);
    expect(provisionCalls).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });

  test("start 500s and seeds no run record when per-run provision fails", async () => {
    resetCaptures();
    provisionShouldThrow = true;
    const a = app();
    const { status, json } = await post(
      a,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    expect(status).toBe(500);
    expect(json.error).toMatch(/failed to provision/);
    // No row seeded and no trigger sent — the run never came into being.
    expect([...runs.values()]).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });

  test("start marks the run failed and 500s when the sidecar trigger send throws", async () => {
    resetCaptures();
    sendShouldThrow = true;
    const a = app();
    const { status, json } = await post(
      a,
      "/workflow-exec/pain-point-collateral/start",
      {
        input: {},
      },
    );
    expect(status).toBe(500);
    expect(json.error).toMatch(/failed to start/);
    // The run was provisioned and the row seeded before the trigger failed; the
    // row is flipped to failed so the UI doesn't poll a phantom run (its orphaned
    // deployment is reclaimed by the terminal-teardown + janitor sweep).
    expect(provisionCalls).toHaveLength(1);
    const seeded = [...runs.values()][0];
    expect(seeded?.status).toBe("failed");
  });

  test("resume delivers the gate signal to the sidecar and optimistically marks running", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    // Simulate the bridge having parked the row at a gate.
    const parked = runs.get(runId);
    if (parked)
      runs.set(runId, {
        ...parked,
        status: "awaiting",
        currentStepId: "select",
      });

    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "note-selection",
      payload: { noteId: "n1" },
    });

    expect(r.status).toBe(200);
    expect(r.json.status).toBe("running"); // optimistic flip so the UI resumes polling
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.runId).toBe(runId);
    expect(sentSignals[0]?.signalName).toBe("note-selection");
    expect(sentSignals[0]?.payload).toEqual({ noteId: "n1" });
    // The signal targets the run's OWN per-run deployment, and re-establish uses
    // that id with the deploy principal recovered from the kind's registry row.
    expect(sentSignals[0]?.agentAddress).toBe("ins_ses_run_1@wf.localhost");
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]?.deploymentId).toBe("ses_run_1");
    expect(ensureCalls[0]?.creatorPrincipalId).toBe("prn-deployer");
  });

  test("resume delivers the signal even though the per-run deployment has NO workflow_run registry row (CL-2582 / B1 regression)", async () => {
    resetCaptures();
    // A db whose registry lookup-by-deploymentId finds NOTHING (per-run
    // deployments write no workflow_run row) but whose kind resolution still
    // returns the operator's row (so the deploy principal is recoverable). Under
    // the pre-fix resume — which located the deployment via findFirst(by
    // deploymentId) — this 404'd, breaking every HITL run. Resume must instead
    // address the run's own deployment and recover the principal by kind.
    const db = {
      query: {
        workflowRun: {
          findMany: async () => [DEFAULT_DEPLOYMENT],
          findFirst: async () => undefined,
        },
      },
    } as unknown as HubDb;
    const a = routerWith({ db });

    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    const parked = runs.get(runId);
    if (parked)
      runs.set(runId, {
        ...parked,
        status: "awaiting",
        currentStepId: "select",
      });

    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "note-selection",
      payload: { noteId: "n1" },
    });

    expect(r.status).toBe(200);
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.agentAddress).toBe("ins_ses_run_1@wf.localhost");
    expect(ensureCalls[0]?.creatorPrincipalId).toBe("prn-deployer");
  });

  test("resume on an unknown run is 404 and sends no signal", async () => {
    resetCaptures();
    const a = app();
    const r = await post(a, "/workflow-exec/records/wfr_missing/resume", {
      signalName: "x",
      payload: {},
    });
    expect(r.status).toBe(404);
    expect(sentSignals).toHaveLength(0);
  });

  test("GET run state is a single record read", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const read = await get(a, `/workflow-exec/records/${start.json.runId}`);
    expect(read.status).toBe(200);
    expect(read.json.runId).toBe(start.json.runId);
    expect(read.json.status).toBe("running");
    // The fresh per-run deploymentId persisted at start round-trips through the
    // read DTO.
    expect(read.json.deploymentId).toBe("ses_run_1");
  });

  test("GET /records lists only the callers own runs (per-user private)", async () => {
    resetCaptures();
    const mine = app();
    const theirs = appAs({ tenantId: "tn-1", principalId: "prn-other" });
    const start = await post(
      mine,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    await post(theirs, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const list = await get(mine, "/workflow-exec/records");
    expect(list.status).toBe(200);
    const ids = list.json.map((r: { runId: string }) => r.runId);
    expect(ids).toContain(start.json.runId);
    expect(ids).toHaveLength(1);
  });

  test("cross-user GET /records/:runId is forbidden 403", async () => {
    resetCaptures();
    const owner = app();
    const start = await post(
      owner,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    const intruder = appAs({ tenantId: "tn-1", principalId: "prn-other" });
    const read = await get(
      intruder,
      `/workflow-exec/records/${start.json.runId}`,
    );
    expect(read.status).toBe(403);
    expect(read.json.error).toBe("Forbidden");
  });

  test("cross-user resume is forbidden 403 and sends no signal", async () => {
    resetCaptures();
    const owner = app();
    const start = await post(
      owner,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    const intruder = appAs({ tenantId: "tn-1", principalId: "prn-other" });
    const r = await post(
      intruder,
      `/workflow-exec/records/${start.json.runId}/resume`,
      {
        signalName: "note-selection",
        payload: {},
      },
    );
    expect(r.status).toBe(403);
    expect(sentSignals).toHaveLength(0);
  });

  test("a run in a tenant outside the callers chain reads as 404", async () => {
    resetCaptures();
    const owner = app();
    const start = await post(
      owner,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    ancestorChain = ["tn-9"];
    try {
      const read = await get(
        appAs({ tenantId: "tn-9", principalId: "prn-9" }),
        `/workflow-exec/records/${start.json.runId}`,
      );
      expect(read.status).toBe(404);
    } finally {
      ancestorChain = ["tn-1"];
    }
  });
});
