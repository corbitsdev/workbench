import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { CryptoProvider } from "@intx/types/runtime";
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import type { RunState } from "../workflow-executor/run-store";

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
// Deploy-time provenance keyed by deploymentId. The record read joins it in so
// the version badge survives an owner disabling the kind.
const deploymentMetas = new Map<
  string,
  { version: string; sha: string; deployedAt: string }
>();
mock.module("../workflow-executor/run-store", () => ({
  setRunStatus: async (
    _db: unknown,
    runId: string,
    status: RunState["status"],
  ) => {
    const found = runs.get(runId);
    if (found) runs.set(runId, structuredClone({ ...found, status }));
  },
  // CL-2755 CAS: fail only if still provisioning.
  failRunIfStillProvisioning: async (_db: unknown, runId: string) => {
    const found = runs.get(runId);
    if (found && found.status === "provisioning") {
      runs.set(runId, structuredClone({ ...found, status: "failed" }));
      return true;
    }
    return false;
  },
  insertRunRecord: async (
    _db: unknown,
    args: {
      runId: string;
      deploymentId: string | null;
      kind: string;
      tenantId: string;
      principalId: string;
      input: unknown;
      originConversationId: string | null;
      status?: RunState["status"];
    },
  ) => {
    const state: RunState = {
      runId: args.runId,
      kind: args.kind,
      tenantId: args.tenantId,
      principalId: args.principalId,
      status: args.status ?? "running",
      ...(args.deploymentId !== null
        ? { deploymentId: args.deploymentId }
        : {}),
      ...(args.originConversationId !== null
        ? { originConversationId: args.originConversationId }
        : {}),
    };
    runs.set(state.runId, structuredClone(state));
    return state;
  },
  // CL-2755: the async start tail attaches the deployment once provisioned.
  setRunDeployment: async (
    _db: unknown,
    runId: string,
    deploymentId: string,
  ) => {
    const found = runs.get(runId);
    if (found) runs.set(runId, structuredClone({ ...found, deploymentId }));
  },
  loadRunRecord: async (_db: unknown, runId: string) => {
    const found = runs.get(runId);
    return found ? structuredClone(found) : null;
  },
  setPendingSignal: async (
    _db: unknown,
    runId: string,
    signal: { signalId: string; signalName: string },
  ) => {
    signalOps.push(`persist:${runId}:${signal.signalName}`);
  },
  loadDeploymentMeta: async (_db: unknown, deploymentId: string) => {
    const found = deploymentMetas.get(deploymentId);
    return found ? structuredClone(found) : null;
  },
  softDeleteRunRecord: async (_db: unknown, runId: string) => {
    runs.delete(runId);
  },
  markRunStopped: async (_db: unknown, state: RunState) => {
    runs.set(state.runId, structuredClone({ ...state, status: "failed" }));
  },
  markRunUserStopped: async (_db: unknown, state: RunState) => {
    runs.set(state.runId, structuredClone({ ...state, status: "stopped" }));
  },
  listRunRecords: async (
    _db: unknown,
    _tenantIds: readonly string[],
    principalId: string,
    kind?: string,
    filters?: { originConversationId?: string; scope?: "own" | "tenant" },
  ) =>
    [...runs.values()]
      // CL-3667: scope=tenant lists every run; the default is caller-scoped.
      .filter(
        (r) => filters?.scope === "tenant" || r.principalId === principalId,
      )
      .filter((r) => kind === undefined || r.kind === kind)
      .filter(
        (r) =>
          filters?.originConversationId === undefined ||
          r.originConversationId === filters.originConversationId,
      )
      .map((r) => ({
        runId: r.runId,
        kind: r.kind,
        status: r.status,
        principalId: r.principalId,
        createdAt: new Date(),
        originConversationId: r.originConversationId ?? null,
      })),
  // CL-2727 stats reads. The aggregation logic is exercised over a real DB in
  // run-stats.integration.test.ts; here the route gating is what matters, so
  // canned shapes suffice.
  getRunKindStats: async (
    _db: unknown,
    _tenantIds: readonly string[],
    _principalId: string,
    kind?: string,
  ) => [
    {
      kind: kind ?? "brief",
      runs: {
        provisioning: 0,
        running: 1,
        awaiting: 0,
        completed: 2,
        failed: 0,
        stopped: 0,
        total: 3,
      },
      steps: { total: 4, byPhase: { completed: 4 }, avgDurationMs: 1500 },
    },
  ],
  listRunSteps: async (_db: unknown, runId: string) => {
    const found = runs.get(runId);
    if (!found) return [];
    return [
      {
        stepId: "s1",
        phase: "completed",
        attempts: 1,
        startedAt: new Date("2026-04-01T00:00:00.000Z"),
        endedAt: new Date("2026-04-01T00:00:02.000Z"),
      },
    ];
  },
}));

// Preserve LogRunStateSchema (the route validates its output through it) and
// override only getWorkflowRunState — the log fold itself is covered by the real
// on-disk integration test; here we prove the route's gating + wiring + shape.
const realRunStateFromLog = await import(
  "../workflow-executor/run-state-from-log"
);
const runStateCalls: {
  deploymentId: string;
  runId: string;
  kind: string;
  deploymentDomain: string;
}[] = [];
let cannedLogState: unknown = {
  runId: "R",
  phase: "failed",
  lastSeq: 3,
  steps: [
    {
      stepId: "s1",
      phase: "completed",
      stepType: "agent",
      currentAttempt: 1,
    },
  ],
};
let runStateShouldThrow = false;
mock.module("../workflow-executor/run-state-from-log", () => ({
  ...realRunStateFromLog,
  getWorkflowRunState: async (
    _deps: unknown,
    args: {
      deploymentId: string;
      runId: string;
      kind: string;
      deploymentDomain: string;
    },
  ) => {
    runStateCalls.push(args);
    if (runStateShouldThrow) throw new Error("truncated log");
    return cannedLogState;
  },
}));

// The live-issue lookup (CL-3887) hits analytics_event via a real db query in
// production; here it is a canned map keyed by stepId so route tests can
// assert the batched attach step without a database.
let cannedLiveIssues = new Map<
  string,
  { category: string; occurredAt: string }
>();
let liveIssueBatchCalls: { stepId: string }[][] = [];
mock.module("../services/run-step-live-issue", () => ({
  getRunStepLiveIssues: async (args: { steps: { stepId: string }[] }) => {
    liveIssueBatchCalls.push(args.steps.map((s) => ({ stepId: s.stepId })));
    const result = new Map<string, { category: string; occurredAt: string }>();
    for (const step of args.steps) {
      const issue = cannedLiveIssues.get(step.stepId);
      if (issue !== undefined) result.set(step.stepId, issue);
    }
    return result;
  },
}));

// The live-gate the resume guard reads (CL-2681). `null` simulates an unreadable
// log (the guard falls back to the coarse index status); an array is the set of
// open awaitSignal names the run is currently parked on.
let cannedAwaitingSignals: string[] | null = null;
mock.module("../workflow-executor/run-awaiting-signals", () => ({
  getAwaitingSignalNames: async (): Promise<Set<string>> => {
    if (cannedAwaitingSignals === null) throw new Error("log unreadable");
    return new Set(cannedAwaitingSignals);
  },
}));

const resolvePrincipalNames = mock(
  async (_db: unknown, _tenantId: string, ids: readonly string[]) => {
    const names = new Map<string, string>();
    for (const id of ids) {
      if (id.length > 0) names.set(id, "Test Owner");
    }
    return names;
  },
);
mock.module("../services/admin-governance", () => ({ resolvePrincipalNames }));

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
// Ordered trace of pending-signal persistence vs. signal dispatch: resume
// must make the accepted signal durable BEFORE the fire-and-forget send.
const signalOps: string[] = [];
const ensureCalls: { deploymentId: string; creatorPrincipalId: string }[] = [];
const provisionCalls: {
  kind: string;
  tenantId: string;
  creatorPrincipalId: string;
}[] = [];
let sendShouldThrow = false;
let provisionShouldThrow = false;
const reclaimCalls: { deploymentId: string; tenantId: string }[] = [];
let reclaimShouldThrow = false;

// CL-2707 deploy-window probe. The probe reports "connected" once the call
// count reaches `sidecarConnectsAtProbe` (1 = connected on the first check =
// the fast path with no wait; a large number = a bounded wait that eventually
// succeeds; Infinity = never connects, forcing the timeout 503).
let sidecarProbeCalls = 0;
let sidecarConnectsAtProbe = 1;
const isSidecarConnected = (): boolean => {
  sidecarProbeCalls += 1;
  return sidecarProbeCalls >= sidecarConnectsAtProbe;
};

function resetCaptures(): void {
  runs.clear();
  deploymentMetas.clear();
  sentMessages.length = 0;
  sentSignals.length = 0;
  signalOps.length = 0;
  ensureCalls.length = 0;
  provisionCalls.length = 0;
  reclaimCalls.length = 0;
  runStateCalls.length = 0;
  sendShouldThrow = false;
  provisionShouldThrow = false;
  reclaimShouldThrow = false;
  runStateShouldThrow = false;
  cannedAwaitingSignals = null;
  sidecarProbeCalls = 0;
  sidecarConnectsAtProbe = 1;
  cannedLiveIssues = new Map();
  liveIssueBatchCalls = [];
}

const reclaimDeployment = async (args: {
  deploymentId: string;
  tenantId: string;
  reason: string;
}) => {
  if (reclaimShouldThrow) throw new Error("teardown failed");
  reclaimCalls.push({
    deploymentId: args.deploymentId,
    tenantId: args.tenantId,
  });
};

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
    signalOps.push(`deliver:${args.runId}:${args.signalName}`);
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
      // CL-2727: the solo stats read fetches run-level timing.
      workflowRunRecord: {
        findFirst: async () => ({ startedAt: null, endedAt: null }),
      },
      // No member-role policy → the CL-2885 run gate allows (default).
      role: { findMany: async () => [] },
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
      repoStore: {} as unknown as Parameters<
        typeof createWorkflowRunRecordsRouter
      >[0]["repoStore"],
      sidecarRouter,
      sessionService,
      cryptoProvider: {} as CryptoProvider,
      deploymentDomain: "wf.localhost",
      ensureDeploymentRoutable,
      provisionRunDeployment,
      reclaimDeployment,
      resolveUserIdentity: async (principalId: string) => ({
        userAddress: `usr_${principalId}@wf.localhost`,
        userRefId: principalId,
      }),
      isSidecarConnected,
      // Tiny bounds keep the deploy-window wait sub-second in tests.
      sidecarWaitTimeoutMs: 200,
      sidecarPollIntervalMs: 5,
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

// CL-2755: the start route responds BEFORE the deploy completes; the provision
// + trigger run on a detached background task. Poll the in-memory row until that
// tail settles (the run failed, or the trigger mail for this run went out) so the
// assertions below observe a deterministic end state, not a race.
async function settleStart(runId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const row = runs.get(runId);
    const triggered = sentMessages.some((m) => m.messageId === runId);
    if (row?.status === "failed" || triggered) return;
    await new Promise((res) => setTimeout(res, 5));
  }
}

describe("workflow runs on the sidecar (records router)", () => {
  test("start returns 'provisioning' immediately then provisions a FRESH per-run deployment and triggers IT, not the shared registry deployment (CL-2582 / CL-2755)", async () => {
    resetCaptures();
    const a = app();
    const { status, json } = await post(
      a,
      "/workflow-exec/pain-point-collateral/start",
      {
        input: { topic: "Acme" },
      },
    );

    // CL-2755: instant ack — the run is seeded `provisioning` with NO deployment
    // yet, and the response lands without waiting for the cold deploy.
    expect(status).toBe(200);
    expect(json.status).toBe("provisioning");
    expect(json.deploymentId).toBeUndefined();
    expect(typeof json.runId).toBe("string");

    await settleStart(json.runId);

    // Provisioned once, into the DEFINITION's tenant + deploy principal (the
    // shared registry row), NOT the caller's principal.
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]).toEqual({
      kind: "pain-point-collateral",
      tenantId: "tn-1",
      creatorPrincipalId: "prn-deployer",
    });

    // The run runs on its OWN fresh deployment, never the shared `ses_dep1`.
    const settled = runs.get(json.runId);
    expect(settled?.deploymentId).toBe("ses_run_1");
    expect(settled?.deploymentId).not.toBe("ses_dep1");

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

  test("start acks 'provisioning' then flips the run to failed when per-run provision fails, and fires no trigger (CL-2755)", async () => {
    resetCaptures();
    provisionShouldThrow = true;
    const a = app();
    const { status, json } = await post(
      a,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    // The ack is instant and optimistic; the failure surfaces on the run record.
    expect(status).toBe(200);
    expect(json.status).toBe("provisioning");

    await settleStart(json.runId);

    // The seeded row is flipped to a visible terminal `failed` — never left stuck
    // provisioning — and no trigger mail ever fires.
    const seeded = runs.get(json.runId);
    expect(seeded?.status).toBe("failed");
    expect(sentMessages).toHaveLength(0);
  });

  test("start acks 'provisioning' then flips the run to failed when the sidecar trigger send throws (CL-2755)", async () => {
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
    expect(status).toBe(200);
    expect(json.status).toBe("provisioning");

    await settleStart(json.runId);

    // The run was provisioned before the trigger failed; the row is flipped to
    // failed so the UI doesn't poll a phantom run (its orphaned deployment is
    // reclaimed by the terminal-teardown + janitor sweep).
    expect(provisionCalls).toHaveLength(1);
    const seeded = runs.get(json.runId);
    expect(seeded?.status).toBe("failed");
  });

  test("resume delivers the gate signal to the sidecar and optimistically marks running", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    // CL-2755: let the async start tail attach the deployment before parking.
    await settleStart(runId);
    // Simulate the bridge having parked the row at a gate.
    const parked = runs.get(runId);
    if (parked)
      runs.set(runId, {
        ...parked,
        status: "awaiting",
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
    // Durable-before-dispatch: the accepted signal is persisted on the run
    // record BEFORE the fire-and-forget delivery, so a hibernate/teardown
    // race can never lose it — the reconciler re-delivers from the record.
    expect(signalOps).toEqual([
      `persist:${runId}:note-selection`,
      `deliver:${runId}:note-selection`,
    ]);
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
        role: { findMany: async () => [] },
      },
    } as unknown as HubDb;
    const a = routerWith({ db });

    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    await settleStart(runId);
    const parked = runs.get(runId);
    if (parked)
      runs.set(runId, {
        ...parked,
        status: "awaiting",
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

  async function parkedAttioRun(a: AppHono): Promise<string> {
    const start = await post(a, "/workflow-exec/attio-task-agent/start", {
      input: {},
    });
    const runId = start.json.runId;
    await settleStart(runId);
    const parked = runs.get(runId);
    if (parked)
      runs.set(runId, {
        ...parked,
        status: "awaiting",
      });
    return runId;
  }

  test("resume rejects an attio sync-approval payload with a non-boolean confirm", async () => {
    resetCaptures();
    const a = app();
    const runId = await parkedAttioRun(a);

    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "sync-approval",
      payload: { confirm: "yes" },
    });

    expect(r.status).toBe(400);
    expect(sentSignals).toHaveLength(0);
  });

  test("resume passes through the agent-decided review payload (no kind-selection validation)", async () => {
    // CL-2664: the plan is agent-decided; there is no kind-selection gate. The
    // human review signal carries approved pieces and is not schema-validated.
    resetCaptures();
    const a = app();
    const runId = await parkedAttioRun(a);

    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "review",
      payload: {
        approvedPieces: [{ type: "cold-email", title: "T", content: "C" }],
      },
    });

    expect(r.status).toBe(200);
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.signalName).toBe("review");
  });

  test("resume passes through a valid attio sync-approval confirm payload", async () => {
    resetCaptures();
    const a = app();
    const runId = await parkedAttioRun(a);

    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "sync-approval",
      payload: { confirm: false },
    });

    expect(r.status).toBe(200);
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.signalName).toBe("sync-approval");
  });

  test("resume does not validate an unregistered signal on a registered kind", async () => {
    resetCaptures();
    const a = app();
    const runId = await parkedAttioRun(a);

    // A signal with NO registered schema for this kind passes through unvalidated.
    // (`task-selection` became registered in CL-2731, so it is no longer a valid
    // stand-in for "unregistered" — use a genuinely-unregistered signal name.)
    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "freeform-note",
      payload: { anything: "goes" },
    });

    expect(r.status).toBe(200);
    expect(sentSignals).toHaveLength(1);
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
    await settleStart(start.json.runId);
    const read = await get(a, `/workflow-exec/records/${start.json.runId}`);
    expect(read.status).toBe(200);
    expect(read.json.runId).toBe(start.json.runId);
    // CL-2755: the record stays `provisioning` until the projection bridge folds
    // the first RunStarted (not exercised here); the read round-trips it.
    expect(read.json.status).toBe("provisioning");
    // The fresh per-run deploymentId the async tail attached round-trips through
    // the read DTO.
    expect(read.json.deploymentId).toBe("ses_run_1");
    expect(read.json.principalId).toBe("prn-1");
    expect(read.json.ownerDisplayName).toBe("Test Owner");
    expect(resolvePrincipalNames).toHaveBeenCalled();
  });

  test("GET run state carries the run's deployment version meta", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    await settleStart(start.json.runId);
    // Provenance for the exact deployment the run's async tail attached. The
    // record read joins it in so the badge does not depend on the gate-filtered
    // catalog list — an owner disabling the kind must not hide it.
    deploymentMetas.set("ses_run_1", {
      version: "3",
      sha: "a1b2c3d",
      deployedAt: "2026-05-01T00:00:00.000Z",
    });
    const read = await get(a, `/workflow-exec/records/${start.json.runId}`);
    expect(read.status).toBe(200);
    expect(read.json.meta).toEqual({
      version: "3",
      sha: "a1b2c3d",
      deployedAt: "2026-05-01T00:00:00.000Z",
    });
  });

  test("GET run state omits meta for a deployment with no provenance", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    await settleStart(start.json.runId);
    const read = await get(a, `/workflow-exec/records/${start.json.runId}`);
    expect(read.status).toBe(200);
    expect(read.json.meta).toBeUndefined();
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

  test("start threads originConversationId from the body into the record, and read exposes it (CL-2677)", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: { topic: "Acme" },
      originConversationId: "conv-42",
    });
    expect(start.status).toBe(200);
    expect(start.json.originConversationId).toBe("conv-42");
    // The stored record carries it — not just the echo.
    expect(runs.get(start.json.runId)?.originConversationId).toBe("conv-42");

    const read = await get(a, `/workflow-exec/records/${start.json.runId}`);
    expect(read.json.originConversationId).toBe("conv-42");
  });

  test("a direct start with no chat context stores no origin and the read omits it (CL-2677)", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    expect(start.status).toBe(200);
    expect(start.json.originConversationId).toBeUndefined();
    expect(runs.get(start.json.runId)?.originConversationId).toBeUndefined();

    const read = await get(a, `/workflow-exec/records/${start.json.runId}`);
    expect(read.json.originConversationId).toBeUndefined();
  });

  test("a schema-invalid start body 400s instead of silently starting with empty input (CL-2677)", async () => {
    resetCaptures();
    const a = app();
    const wrongType = await post(
      a,
      "/workflow-exec/pain-point-collateral/start",
      { input: {}, originConversationId: 123 },
    );
    expect(wrongType.status).toBe(400);

    const overlong = await post(
      a,
      "/workflow-exec/pain-point-collateral/start",
      { input: {}, originConversationId: "c".repeat(257) },
    );
    expect(overlong.status).toBe(400);

    // Neither invalid body may have started a run.
    expect(runs.size).toBe(0);
  });

  test("GET /records exposes each run's origin and ?originConversationId= filters to that chat's runs (CL-2677)", async () => {
    resetCaptures();
    const a = app();
    const inChat = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
      originConversationId: "conv-42",
    });
    const direct = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });

    const all = await get(a, "/workflow-exec/records");
    expect(all.json).toHaveLength(2);
    const byId = new Map(
      all.json.map((r: { runId: string; originConversationId: unknown }) => [
        r.runId,
        r.originConversationId,
      ]),
    );
    expect(byId.get(inChat.json.runId)).toBe("conv-42");
    expect(byId.get(direct.json.runId)).toBeNull();

    const filtered = await get(
      a,
      "/workflow-exec/records?originConversationId=conv-42",
    );
    expect(filtered.json.map((r: { runId: string }) => r.runId)).toEqual([
      inChat.json.runId,
    ]);
  });

  test("GET /records enriches each run with its starter identity and isSelf; ?scope=tenant lists every actor's runs (CL-3667)", async () => {
    resetCaptures();
    runs.set("wfr_mine", {
      runId: "wfr_mine",
      kind: "pain-point-collateral",
      tenantId: "tn-1",
      principalId: "prn-1",
      status: "running",
      deploymentId: "ses_a",
    });
    runs.set("wfr_theirs", {
      runId: "wfr_theirs",
      kind: "pain-point-collateral",
      tenantId: "tn-1",
      principalId: "prn-2",
      status: "completed",
      deploymentId: "ses_b",
    });
    const a = app();

    type ListedRun = {
      runId: string;
      principalId: string;
      isSelf: boolean;
      ownerDisplayName?: string;
    };

    // Default (own) scope: only the caller's (prn-1) run, marked isSelf.
    const own = await get(a, "/workflow-exec/records");
    const ownRows = own.json as ListedRun[];
    expect(ownRows.map((r) => r.runId)).toEqual(["wfr_mine"]);
    expect(ownRows[0]?.principalId).toBe("prn-1");
    expect(ownRows[0]?.isSelf).toBe(true);
    expect(ownRows[0]?.ownerDisplayName).toBe("Test Owner");

    // Tenant scope: both actors' runs, each carrying its starter identity, with
    // isSelf true only for the caller's own run.
    const tenant = await get(a, "/workflow-exec/records?scope=tenant");
    const byId = new Map((tenant.json as ListedRun[]).map((r) => [r.runId, r]));
    expect(byId.size).toBe(2);
    expect(byId.get("wfr_mine")?.isSelf).toBe(true);
    expect(byId.get("wfr_theirs")?.isSelf).toBe(false);
    expect(byId.get("wfr_theirs")?.principalId).toBe("prn-2");
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

/** Valid pain-point resume bodies so gate-guard tests reach CL-2681, not schema 400s. */
const PAIN_POINT_NOTE_SELECTION = { noteId: "n1" };
const PAIN_POINT_REVIEW_EMPTY = { approvedPieces: [], decisions: [] };

describe("resume gate-guard: stale/mismatched resume is a 409 (CL-2681)", () => {
  // Seed a run at a given coarse status without going through /start (which
  // always seeds 'running'); the guard must consult the live gate, not trust an
  // optimistic caller.
  function seedRun(status: RunState["status"]): string {
    const runId = "wfr_guard";
    runs.set(runId, {
      runId,
      kind: "pain-point-collateral",
      tenantId: "tn-1",
      principalId: "prn-1",
      status,
      deploymentId: "ses_run_1",
      originConversationId: "conv-1",
    });
    return runId;
  }

  test("resume against a run whose log shows no open gate is 409 — no signal, no status flip", async () => {
    resetCaptures();
    cannedAwaitingSignals = []; // readable log, but nothing is awaiting
    const a = app();
    const runId = seedRun("running");

    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "note-selection",
      payload: PAIN_POINT_NOTE_SELECTION,
    });

    expect(r.status).toBe(409);
    expect(sentSignals).toHaveLength(0);
    expect(ensureCalls).toHaveLength(0);
    expect(runs.get(runId)?.status).toBe("running"); // not resurrected
  });

  test.each(["completed", "failed", "running", "stopped"] as const)(
    "resume against a %s run (log unreadable, coarse status not awaiting) is 409 and fires no signal",
    async (status) => {
      resetCaptures();
      cannedAwaitingSignals = null; // unreadable → falls back to index status
      const a = app();
      const runId = seedRun(status);

      const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
        signalName: "note-selection",
        payload: PAIN_POINT_NOTE_SELECTION,
      });

      expect(r.status).toBe(409);
      expect(sentSignals).toHaveLength(0);
      expect(runs.get(runId)?.status).toBe(status); // status unchanged
    },
  );

  test("resume with a signalName that does not match the open gate is 409", async () => {
    resetCaptures();
    cannedAwaitingSignals = ["review"]; // the run is parked on 'review'
    const a = app();
    const runId = seedRun("awaiting");

    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "note-selection", // wrong gate
      payload: PAIN_POINT_NOTE_SELECTION,
    });

    expect(r.status).toBe(409);
    expect(sentSignals).toHaveLength(0);
    expect(runs.get(runId)?.status).toBe("awaiting"); // not flipped
  });

  test("resume whose signalName matches the open gate is delivered and flips to running", async () => {
    resetCaptures();
    cannedAwaitingSignals = ["review"];
    const a = app();
    const runId = seedRun("awaiting");

    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "review",
      payload: PAIN_POINT_REVIEW_EMPTY,
    });

    expect(r.status).toBe(200);
    expect(r.json.status).toBe("running");
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.signalName).toBe("review");
  });
});

describe("GET /workflow-exec/runs/:runId/state — log-derived RunState (CL-2669)", () => {
  test("returns the folded log state for the run's owner, addressed by its deployment + kind", async () => {
    resetCaptures();
    cannedLogState = {
      runId: "R",
      phase: "failed",
      lastSeq: 3,
      steps: [
        {
          stepId: "s1",
          phase: "completed",
          stepType: "agent",
          currentAttempt: 1,
        },
        { stepId: "s2", phase: "failed", stepType: "human", currentAttempt: 1 },
      ],
    };
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    await settleStart(runId);

    const read = await get(a, `/workflow-exec/runs/${runId}/state`);
    expect(read.status).toBe(200);
    expect(read.json.phase).toBe("failed");
    expect(read.json.steps).toHaveLength(2);
    // Addressed by the run's OWN per-run deployment + its kind, pulled from the
    // seeded record — not from any client-supplied field.
    expect(runStateCalls).toEqual([
      {
        deploymentId: "ses_run_1",
        runId,
        kind: "pain-point-collateral",
        deploymentDomain: "wf.localhost",
      },
    ]);
  });

  test("500s and does not return an unvalidated body when the fold yields a bad shape", async () => {
    resetCaptures();
    cannedLogState = {
      runId: "R",
      phase: "not-a-phase",
      lastSeq: 0,
      steps: [],
    };
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    await settleStart(start.json.runId);
    const read = await get(a, `/workflow-exec/runs/${start.json.runId}/state`);
    expect(read.status).toBe(500);
    expect(read.json.error).toBe("failed to read run state");
  });

  test("a fold/read failure degrades to an empty pending state (200), never a 500 that bricks the pane", async () => {
    resetCaptures();
    runStateShouldThrow = true;
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    await settleStart(start.json.runId);
    const read = await get(a, `/workflow-exec/runs/${start.json.runId}/state`);
    expect(read.status).toBe(200);
    expect(read.json.phase).toBe("pending");
    expect(read.json.steps).toEqual([]);
    expect(read.json.runId).toBe(start.json.runId);
    // The read WAS attempted (and threw) — the route did not silently skip it.
    expect(runStateCalls).toHaveLength(1);
  });

  test("cross-user read is forbidden 403 and never reads the log", async () => {
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
      `/workflow-exec/runs/${start.json.runId}/state`,
    );
    expect(read.status).toBe(403);
    expect(runStateCalls).toHaveLength(0);
  });

  test("unknown run is 404 and never reads the log", async () => {
    resetCaptures();
    const a = app();
    const read = await get(a, "/workflow-exec/runs/wfr_missing/state");
    expect(read.status).toBe(404);
    expect(runStateCalls).toHaveLength(0);
  });

  test("attaches a live inference issue to an in-flight agent step (CL-3887)", async () => {
    resetCaptures();
    cannedLogState = {
      runId: "R",
      phase: "running",
      lastSeq: 3,
      steps: [
        {
          stepId: "draft",
          phase: "in-flight",
          stepType: "agent",
          currentAttempt: 2,
          startedAt: "2026-07-18T00:00:00.000Z",
        },
        {
          stepId: "review",
          phase: "in-flight",
          stepType: "inline",
          currentAttempt: 1,
          startedAt: "2026-07-18T00:00:00.000Z",
        },
        {
          stepId: "gate",
          phase: "completed",
          stepType: "human",
          currentAttempt: 1,
        },
      ],
    };
    cannedLiveIssues.set("draft", {
      category: "timeout",
      occurredAt: "2026-07-18T00:01:00.000Z",
    });
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    await settleStart(start.json.runId);

    const read = await get(a, `/workflow-exec/runs/${start.json.runId}/state`);
    expect(read.status).toBe(200);
    const draftStep = read.json.steps.find(
      (s: { stepId: string }) => s.stepId === "draft",
    );
    expect(draftStep.liveIssue).toEqual({
      category: "timeout",
      occurredAt: "2026-07-18T00:01:00.000Z",
    });
    const reviewStep = read.json.steps.find(
      (s: { stepId: string }) => s.stepId === "review",
    );
    expect(reviewStep.liveIssue).toBeUndefined();
    const gateStep = read.json.steps.find(
      (s: { stepId: string }) => s.stepId === "gate",
    );
    expect(gateStep.liveIssue).toBeUndefined();

    // Both in-flight candidates are resolved through a SINGLE batched call —
    // not one query per step (CL-3887 review) — and the completed gate step
    // is never a candidate.
    expect(liveIssueBatchCalls).toHaveLength(1);
    expect(liveIssueBatchCalls[0]?.map((s) => s.stepId).sort()).toEqual([
      "draft",
      "review",
    ]);
  });

  test("a run with no deployment is 400 and never reads the log", async () => {
    resetCaptures();
    const a = routerWith({ db: makeDb() });
    // A run record with no deploymentId (legacy / never-provisioned).
    runs.set("wfr_nodeploy", {
      runId: "wfr_nodeploy",
      kind: "pain-point-collateral",
      tenantId: "tn-1",
      principalId: "prn-1",
      status: "running",
    });
    const read = await get(a, "/workflow-exec/runs/wfr_nodeploy/state");
    expect(read.status).toBe(400);
    expect(runStateCalls).toHaveLength(0);
  });
});

// biome-ignore lint/suspicious/noExplicitAny: test response shape
async function archive(
  a: AppHono,
  runId: string,
): Promise<{ status: number; error?: string }> {
  const res = await a.request(`/workflow-exec/records/${runId}/archive`, {
    method: "POST",
  });
  if (res.status === 200) return { status: 200 };
  const json = (await res.json()) as { error?: string };
  const out: { status: number; error?: string } = { status: res.status };
  if (json.error !== undefined) out.error = json.error;
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: test response shape
async function stopRun(
  a: AppHono,
  runId: string,
): Promise<{ status: number; error?: string; stopped?: boolean }> {
  const res = await a.request(`/workflow-exec/records/${runId}/stop`, {
    method: "POST",
  });
  if (res.status === 200) {
    const json = (await res.json()) as { stopped?: boolean };
    return { status: 200, stopped: json.stopped };
  }
  const json = (await res.json()) as { error?: string };
  const out: { status: number; error?: string } = { status: res.status };
  if (json.error !== undefined) out.error = json.error;
  return out;
}

describe("stop workflow run (CL-3688)", () => {
  test("stopping a PROVISIONING run marks stopped and reclaims deployment", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    expect(runs.get(runId)?.status).toBe("provisioning");

    const r = await stopRun(a, runId);
    expect(r.status).toBe(200);
    expect(reclaimCalls).toEqual([
      { deploymentId: "ses_run_1", tenantId: "tn-1" },
    ]);
    expect(runs.get(runId)?.status).toBe("stopped");
  });

  test("stopping an ACTIVE run marks stopped, tears down deployment, and keeps the record", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    await settleStart(runId);

    const r = await stopRun(a, runId);
    expect(r.status).toBe(200);
    expect(r.stopped).toBe(true);
    expect(reclaimCalls).toEqual([
      { deploymentId: "ses_run_1", tenantId: "tn-1" },
    ]);
    expect(runs.get(runId)?.status).toBe("stopped");
    const list = await get(a, "/workflow-exec/records");
    expect(list.json.map((x: { runId: string }) => x.runId)).toContain(runId);
  });

  test("stopping an AWAITING run marks stopped and reclaims deployment", async () => {
    resetCaptures();
    const a = app();
    const runId = await seedParkedRun(a);

    const r = await stopRun(a, runId);
    expect(r.status).toBe(200);
    expect(reclaimCalls).toEqual([
      { deploymentId: "ses_run_1", tenantId: "tn-1" },
    ]);
    expect(runs.get(runId)?.status).toBe("stopped");
  });

  test("stopping a TERMINAL run is idempotent — no teardown", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    const done = runs.get(runId);
    if (done) runs.set(runId, { ...done, status: "completed" });

    const r = await stopRun(a, runId);
    expect(r.status).toBe(200);
    expect(reclaimCalls).toHaveLength(0);
    expect(runs.get(runId)?.status).toBe("completed");
  });

  test("stopping an already stopped run is idempotent", async () => {
    resetCaptures();
    const a = app();
    const runId = "wfr_stopped_idem";
    runs.set(runId, {
      runId,
      kind: "pain-point-collateral",
      tenantId: "tn-1",
      principalId: "prn-1",
      status: "stopped",
      deploymentId: "ses_run_1",
      originConversationId: "conv-1",
    });
    const r = await stopRun(a, runId);
    expect(r.status).toBe(200);
    expect(reclaimCalls).toHaveLength(0);
    expect(runs.get(runId)?.status).toBe("stopped");
  });

  test("stopping a run you do not own is forbidden 403", async () => {
    resetCaptures();
    const owner = app();
    const start = await post(
      owner,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    const runId = start.json.runId;
    await settleStart(runId);
    const intruder = appAs({ tenantId: "tn-1", principalId: "prn-other" });

    const r = await stopRun(intruder, runId);
    expect(r.status).toBe(403);
    expect(reclaimCalls).toHaveLength(0);
    const list = await get(owner, "/workflow-exec/records");
    expect(list.json.map((x: { runId: string }) => x.runId)).toContain(runId);
  });

  test("stopping an unknown run is 404", async () => {
    resetCaptures();
    const a = app();
    const r = await stopRun(a, "wfr_missing");
    expect(r.status).toBe(404);
    expect(reclaimCalls).toHaveLength(0);
  });
});

describe("archive workflow run (CL-2629)", () => {
  test("archiving an ACTIVE run tears its per-run deployment down and drops it from the list", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    await settleStart(runId);

    const r = await archive(a, runId);
    expect(r.status).toBe(200);
    // The run's OWN per-run deployment (ses_run_1) is reclaimed immediately,
    // in the run's tenant — no waiting for the boot-reconciler.
    expect(reclaimCalls).toEqual([
      { deploymentId: "ses_run_1", tenantId: "tn-1" },
    ]);
    // Soft-deleted: it no longer appears in the caller's run list.
    const list = await get(a, "/workflow-exec/records");
    expect(list.json.map((x: { runId: string }) => x.runId)).not.toContain(
      runId,
    );
  });

  test("archiving an AWAITING (HITL-parked) run tears its deployment down too — awaiting is non-terminal", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    await settleStart(runId);
    // Park the run at a gate, as the projection bridge would.
    const parked = runs.get(runId);
    if (parked)
      runs.set(runId, {
        ...parked,
        status: "awaiting",
      });

    const r = await archive(a, runId);
    expect(r.status).toBe(200);
    expect(reclaimCalls).toEqual([
      { deploymentId: "ses_run_1", tenantId: "tn-1" },
    ]);
    const list = await get(a, "/workflow-exec/records");
    expect(list.json).toHaveLength(0);
  });

  test("archiving a TERMINAL run soft-deletes only — no teardown (already reclaimed on terminal transition)", async () => {
    resetCaptures();
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    const done = runs.get(runId);
    if (done) runs.set(runId, { ...done, status: "completed" });

    const r = await archive(a, runId);
    expect(r.status).toBe(200);
    expect(reclaimCalls).toHaveLength(0);
    const list = await get(a, "/workflow-exec/records");
    expect(list.json).toHaveLength(0);
  });

  test("archiving a run you do not own is forbidden 403 — no teardown, run untouched", async () => {
    resetCaptures();
    const owner = app();
    const start = await post(
      owner,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    const runId = start.json.runId;
    const intruder = appAs({ tenantId: "tn-1", principalId: "prn-other" });

    const r = await archive(intruder, runId);
    expect(r.status).toBe(403);
    expect(reclaimCalls).toHaveLength(0);
    const list = await get(owner, "/workflow-exec/records");
    expect(list.json.map((x: { runId: string }) => x.runId)).toContain(runId);
  });

  test("archiving an unknown run is 404 and tears nothing down", async () => {
    resetCaptures();
    const a = app();
    const r = await archive(a, "wfr_missing");
    expect(r.status).toBe(404);
    expect(reclaimCalls).toHaveLength(0);
  });

  test("a teardown failure still soft-deletes the run (best-effort teardown)", async () => {
    resetCaptures();
    reclaimShouldThrow = true;
    const a = app();
    const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    const runId = start.json.runId;
    await settleStart(runId);

    const r = await archive(a, runId);
    expect(r.status).toBe(200);
    const list = await get(a, "/workflow-exec/records");
    expect(list.json).toHaveLength(0);
  });
});

// Seed a parked (awaiting) run without exercising the deploy-window probe, then
// reset the probe counter so the resume-side assertions start from zero.
async function seedParkedRun(a: AppHono): Promise<string> {
  const start = await post(a, "/workflow-exec/pain-point-collateral/start", {
    input: {},
  });
  const runId = start.json.runId;
  // CL-2755: wait for the async start tail to attach the deployment (resume
  // needs it), THEN park the run at a gate.
  await settleStart(runId);
  const parked = runs.get(runId);
  if (parked) runs.set(runId, { ...parked, status: "awaiting" });
  cannedAwaitingSignals = ["note-selection"];
  sidecarProbeCalls = 0;
  return runId;
}

describe("deploy-window: bounded wait for the sidecar (CL-2707)", () => {
  test("resume takes the fast path (one probe, no wait, signal delivered) when the sidecar is already connected", async () => {
    resetCaptures();
    const a = app();
    const runId = await seedParkedRun(a);
    // sidecarConnectsAtProbe stays 1: connected on the first probe.
    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "note-selection",
      payload: PAIN_POINT_NOTE_SELECTION,
    });
    expect(r.status).toBe(200);
    expect(sentSignals).toHaveLength(1);
    // Exactly one probe and never entered the poll loop.
    expect(sidecarProbeCalls).toBe(1);
  });

  test("resume waits then succeeds when the sidecar connects after a few polls", async () => {
    resetCaptures();
    const a = app();
    const runId = await seedParkedRun(a);
    sidecarConnectsAtProbe = 3; // false, false, then connected

    const r = await post(a, `/workflow-exec/records/${runId}/resume`, {
      signalName: "note-selection",
      payload: PAIN_POINT_NOTE_SELECTION,
    });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("running");
    // It waited (multiple probes) before delivering the gate signal.
    expect(sidecarProbeCalls).toBeGreaterThanOrEqual(3);
    expect(sentSignals).toHaveLength(1);
    expect(ensureCalls).toHaveLength(1);
  });

  test("resume times out to a sanitized 503 with Retry-After (never a raw 500) and delivers no signal", async () => {
    resetCaptures();
    const a = app();
    const runId = await seedParkedRun(a);
    sidecarConnectsAtProbe = Number.POSITIVE_INFINITY; // never connects

    const res = await a.request(`/workflow-exec/records/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signalName: "note-selection",
        payload: PAIN_POINT_NOTE_SELECTION,
      }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("10");
    const json = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(json.error.code).toBe("deploy_in_progress");
    expect(typeof json.error.message).toBe("string");
    // The raw signal-failure 500 must never leak here.
    expect(res.status).not.toBe(500);
    // Nothing was attempted against the sidecar.
    expect(ensureCalls).toHaveLength(0);
    expect(sentSignals).toHaveLength(0);
  });

  test("start's background tail takes the fast path and provisions when the sidecar is already connected (CL-2755)", async () => {
    resetCaptures();
    const a = app();
    const r = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    // Instant ack; the sidecar probe + provision happen on the background tail.
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("provisioning");
    await settleStart(r.json.runId);
    expect(provisionCalls).toHaveLength(1);
    expect(sidecarProbeCalls).toBe(1);
  });

  test("start's background tail waits then provisions when the sidecar connects after a few polls (CL-2755)", async () => {
    resetCaptures();
    sidecarConnectsAtProbe = 3;
    const a = app();
    const r = await post(a, "/workflow-exec/pain-point-collateral/start", {
      input: {},
    });
    expect(r.status).toBe(200);
    await settleStart(r.json.runId);
    expect(sidecarProbeCalls).toBeGreaterThanOrEqual(3);
    expect(provisionCalls).toHaveLength(1);
    expect(sentMessages).toHaveLength(1);
  });

  test("start still acks instantly but the background tail flips the run failed (provisioning nothing) when the sidecar never reconnects (CL-2755)", async () => {
    resetCaptures();
    sidecarConnectsAtProbe = Number.POSITIVE_INFINITY;
    const a = app();
    const { status, json } = await post(
      a,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    // The move off the critical path (CL-2755): start no longer blocks or 503s
    // on the deploy window — it acks `provisioning` immediately.
    expect(status).toBe(200);
    expect(json.status).toBe("provisioning");

    await settleStart(json.runId);

    // The tail waited for a sidecar, timed out, and marked the run failed loudly
    // — provisioning nothing and firing no trigger.
    expect(runs.get(json.runId)?.status).toBe("failed");
    expect(provisionCalls).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });
});

describe("GET /workflow-exec/stats (CL-2727)", () => {
  test("aggregate mode returns the by-kind stats for the caller", async () => {
    const { status, json } = await get(app(), "/workflow-exec/stats");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json[0].kind).toBe("brief");
    expect(json[0].runs.total).toBe(3);
    expect(json[0].steps.avgDurationMs).toBe(1500);
  });

  test("kind filter is passed through to the aggregate", async () => {
    const { status, json } = await get(app(), "/workflow-exec/stats?kind=deck");
    expect(status).toBe(200);
    expect(json[0].kind).toBe("deck");
  });

  test("solo mode returns a seeded run's per-step breakdown with durations", async () => {
    resetCaptures();
    const a = app();
    // Seed a run via /start so loadRunRecord (the in-memory mock) finds it.
    const started = await post(
      a,
      "/workflow-exec/pain-point-collateral/start",
      { input: {} },
    );
    expect(started.status).toBe(200);
    const runId = started.json.runId as string;

    const { status, json } = await get(
      a,
      `/workflow-exec/stats?runId=${runId}`,
    );
    expect(status).toBe(200);
    expect(json.runId).toBe(runId);
    expect(json.steps).toHaveLength(1);
    expect(json.steps[0].stepId).toBe("s1");
    expect(json.steps[0].durationMs).toBe(2000);
  });

  test("solo mode 404s for an unknown run", async () => {
    const { status } = await get(app(), "/workflow-exec/stats?runId=nope");
    expect(status).toBe(404);
  });
});
