// Mirrors packages/task-planner/src/spawn.test.ts's fake-db/deps
// harness for exercising `spawnFromTaskSpec` (via `launchTask`) under
// the hood, extended with a `PlannerRunDeps` fake for the
// `agentDefinitionId`-omitted path. `@corbits/folded-runs` is mocked at
// the module level for the same reason spawn.test.ts mocks it: this
// route composes the real `spawnFromTaskSpec`/`runPlanner` — never a
// reimplementation of task spawning — so proving the route's branch
// selection honestly means driving that real machinery through a fake
// `TaskLauncherDeps`, not stubbing the route's own dispatch logic away.
import { describe, expect, mock, test } from "bun:test";
import { task as taskTable, taskLeg as taskLegTable } from "@corbits/tasks";
import type { TaskLegRecord, TaskRecord, TaskStore } from "@corbits/tasks";
import type { SpawnDeps } from "./spawn";
import type { PlannerRunDeps } from "./planner-run";

const actualFoldedRuns = await import("@corbits/folded-runs");

mock.module("@corbits/folded-runs", () => ({
  ...actualFoldedRuns,
  launchFoldedRun: async (
    deps: {
      db: { transaction(fn: (tx: unknown) => Promise<void>): Promise<void> };
    },
    params: { persistExtra?: (tx: unknown) => Promise<void> },
  ) => {
    await deps.db.transaction(async (tx) => {
      if (params.persistExtra !== undefined) await params.persistExtra(tx);
    });
    return { instancePrincipalId: "prn_run", sessionId: "sess_1" };
  },
  sendFoldedMailWithRetry: async () => ({
    ok: true as const,
    mail: { id: "mail_1", createdAt: new Date().toISOString() },
  }),
}));

const { createWorkflowDispatchRoutes } =
  await import("./workflow-dispatch-routes");
const { PlannerMyraUnavailableError } = await import("./planner-run");

const AGENT_WORKFLOW_JSON = {
  id: "wfd_agent",
  stepOrder: ["agent"],
  steps: {
    agent: {
      kind: "step",
      agent: {
        systemPrompt: "You summarize incidents.",
        inference: { sources: [{ model: "declared-default-model" }] },
      },
    },
  },
};

const DEFINITION_ROW = {
  id: "wfd_agent",
  tenantId: "tnt_1",
  status: "deployed",
  assetId: "ast_1",
  name: "incident-bot",
};
const TENANT_ROW = { id: "tnt_1", domain: "acme.example" };

type InsertChain = {
  onConflictDoNothing(): InsertChain;
  returning(): Promise<unknown[]>;
};

function createFakeDb() {
  const inserted: { table: unknown; values: unknown }[] = [];
  function insertOn(table: unknown, values: unknown): InsertChain {
    inserted.push({ table, values });
    const chain: InsertChain = {
      onConflictDoNothing: () => chain,
      returning: () => Promise.resolve([]),
    };
    return chain;
  }
  return {
    inserted,
    query: {
      workflowDefinition: { findFirst: async () => DEFINITION_ROW },
      tenant: { findFirst: async () => TENANT_ROW },
    },
    insert(table: unknown) {
      return { values: (values: unknown) => insertOn(table, values) };
    },
    update() {
      return { set: () => ({ where: async () => undefined }) };
    },
    async transaction(fn: (tx: unknown) => Promise<void>) {
      await fn({
        insert(table: unknown) {
          return { values: (values: unknown) => insertOn(table, values) };
        },
      });
    },
  };
}

/** Copied from spawn.test.ts: a `TaskStore` view over the fake db's
 * recorded `task` inserts, extended with a real `linkPlannerRun` so
 * `spawnFromTaskSpec`'s post-launch link is observable. */
function storeOverInserts(db: {
  inserted: { table: unknown; values: unknown }[];
}): TaskStore {
  const plannerRunIds = new Map<string, string>();
  function legRows(): TaskLegRecord[] {
    return db.inserted
      .filter((row) => row.table === taskLegTable)
      .flatMap((row) => row.values as TaskLegRecord[])
      .sort((a, b) => a.position - b.position);
  }
  function rows(): TaskRecord[] {
    return db.inserted
      .filter((row) => row.table === taskTable)
      .map((row) => {
        const values = row.values as Omit<TaskRecord, "runIds" | "stepCount">;
        const legs = legRows().filter((leg) => leg.taskId === values.id);
        return {
          ...values,
          runIds: legs
            .map((leg) => leg.runId)
            .filter((runId): runId is string => runId !== null),
          stepCount: legs.length,
          plannerRunId: plannerRunIds.get(values.id) ?? values.plannerRunId,
        };
      });
  }
  return {
    async createTask() {
      throw new Error("launchTask persists via persistExtra, never createTask");
    },
    async getTask(tenantId, id) {
      return (
        rows().find((row) => row.tenantId === tenantId && row.id === id) ?? null
      );
    },
    async getTaskByRunId(runId) {
      const leg = legRows().find((candidate) => candidate.runId === runId);
      if (leg === undefined) return null;
      return rows().find((row) => row.id === leg.taskId) ?? null;
    },
    async listTasks(tenantId) {
      return rows().filter((row) => row.tenantId === tenantId);
    },
    async completeTask() {
      return null;
    },
    async recordResultMail() {},
    async linkPlannerRun(input) {
      plannerRunIds.set(input.id, input.plannerRunId);
    },
    async listLegs(tenantId, taskId) {
      return legRows().filter(
        (leg) => leg.tenantId === tenantId && leg.taskId === taskId,
      );
    },
    async getLegByRunId(runId) {
      return legRows().find((leg) => leg.runId === runId) ?? null;
    },
    async claimLegDispatch() {
      return null;
    },
    async recordLegRun() {
      return null;
    },
    async confirmLegDelivery() {
      return null;
    },
    async listStuckLegDispatches() {
      return [];
    },
    async settleLeg() {
      return null;
    },
    async failLegDispatch() {
      return null;
    },
  };
}

function createTaskLauncherDeps(db: ReturnType<typeof createFakeDb>) {
  return {
    db: db as never,
    store: storeOverInserts(db),
    foldedRuns: {
      db: db as never,
      sessionService: {
        async deploySingleStepAtHead() {
          return { publicKey: "test-public-key" };
        },
        async sendUserMessage() {
          return new TextEncoder().encode("raw-mime-bytes");
        },
        async endSession() {},
      } as never,
      assetService: {
        async readAssetBlob() {
          return new TextEncoder().encode(JSON.stringify(AGENT_WORKFLOW_JSON));
        },
      } as never,
      sidecarRouter: { dispatchAgentEvent() {} } as never,
      eventCollectors: { create() {}, abandon() {} } as never,
    },
    cryptoProviders: {
      async get() {
        return {} as never;
      },
    },
    notify: {
      mail: async () => [],
      addressing: {
        inbox: (r: { principalId: string }) => `${r.principalId}@inbox.test`,
        from: (kind: string) => `${kind}@notify.test`,
      },
      dispatch: { enqueue: async () => undefined },
      sinks: {},
    } as never,
    isTaskableDefinition: () => true,
  };
}

function neverCalledDeployAgentDefinition() {
  return mock(() => {
    throw new Error(
      "deployAgentDefinition should never be reached for a {use} spec",
    );
  });
}

function neverCalledRequireDefinitionCreateGrant() {
  return mock(() => {
    throw new Error(
      "requireDefinitionCreateGrant should never be reached for a {use} spec",
    );
  });
}

function neverCalledUndeploy() {
  return mock(() => {
    throw new Error("undeployAgentDefinition should never be reached");
  });
}

function buildSpawnDeps(db: ReturnType<typeof createFakeDb>): SpawnDeps {
  return {
    taskLauncherDeps: createTaskLauncherDeps(db) as never,
    store: storeOverInserts(db),
    deployAgentDefinition: neverCalledDeployAgentDefinition(),
    requireDefinitionCreateGrant: neverCalledRequireDefinitionCreateGrant(),
    undeployAgentDefinition: neverCalledUndeploy(),
  };
}

function neverCalledRunner(): PlannerRunDeps["runner"] {
  return {
    run: mock(() => {
      throw new Error(
        "the planner runner should never be reached when agentDefinitionId is given",
      );
    }),
  };
}

function neverCalledResolveMyraDefinitionId() {
  return mock(() => {
    throw new Error(
      "resolveMyraDefinitionId should never be reached when agentDefinitionId is given",
    );
  });
}

/** A `PlannerRunDeps` fake whose `runner.run` replies with a `{use}`
 * spec naming the fake db's own `wfd_agent` — enough for `runPlanner`
 * to produce a valid, inventory-checked `TaskSpec` without any real
 * inference. `db` is unused by `runPlanner` itself (only
 * `resolveMyraDefinitionIdFromDb`, which this route never calls — the
 * route is handed `resolveMyraDefinitionId` directly), so it's a bare
 * stand-in. */
function buildPlannerRunDeps(overrides: {
  runner?: PlannerRunDeps["runner"];
  resolveMyraDefinitionId?: PlannerRunDeps["resolveMyraDefinitionId"];
}): PlannerRunDeps {
  return {
    db: {} as never,
    runner: overrides.runner ?? {
      run: async () => ({
        content: JSON.stringify({
          kind: "task",
          use: "wfd_agent",
          refinedOutcome: "Summarize the incident",
        }),
        runId: "wfr_planner_1",
      }),
    },
    inventorySources: {
      listConversationalAgents: async () => [
        { id: "wfd_agent", name: "incident-bot", displayName: "Incident bot" },
      ],
      listUsableToolPackages: async () => [],
      listSkills: async () => [],
      memoryAvailable: false,
      listModels: async () => [],
    },
    resolveMyraDefinitionId:
      overrides.resolveMyraDefinitionId ?? (async () => "wfd_myra"),
  };
}

const RUN_SCOPE = {
  tenantId: "tnt_1",
  principalId: "prn_alice",
  runId: "wfr_1",
};

function authenticatorFor(scope: typeof RUN_SCOPE | null) {
  return { resolve: mock(async () => scope) };
}

async function postDispatch(
  app: ReturnType<typeof createWorkflowDispatchRoutes>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {
    authorization: "Bearer sc-token",
    "x-workflow-run-address": "run_1@workflow",
  },
) {
  return app.request("/dispatch", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createWorkflowDispatchRoutes", () => {
  test("rejects a missing or unrecognized sidecar token / run address without dispatching anything", async () => {
    const authenticator = authenticatorFor(null);
    const db = createFakeDb();
    const spawnDeps = buildSpawnDeps(db);
    const plannerRunDeps = buildPlannerRunDeps({
      runner: neverCalledRunner(),
      resolveMyraDefinitionId: neverCalledResolveMyraDefinitionId(),
    });

    const app = createWorkflowDispatchRoutes({
      authenticator,
      ...spawnDeps,
      ...plannerRunDeps,
    });

    const response = await postDispatch(
      app,
      { outcome: "Summarize the incident" },
      {},
    );

    expect(response.status).toBe(401);
    expect(authenticator.resolve).toHaveBeenCalledTimes(1);
  });

  test("agentDefinitionId given: dispatches directly against the named agent, never re-asking the planner", async () => {
    const authenticator = authenticatorFor(RUN_SCOPE);
    const db = createFakeDb();
    const spawnDeps = buildSpawnDeps(db);
    const runner = neverCalledRunner();
    const resolveMyraDefinitionId = neverCalledResolveMyraDefinitionId();
    const plannerRunDeps = buildPlannerRunDeps({
      runner,
      resolveMyraDefinitionId,
    });

    const app = createWorkflowDispatchRoutes({
      authenticator,
      ...spawnDeps,
      ...plannerRunDeps,
    });

    const response = await postDispatch(app, {
      outcome: "Summarize the incident",
      agentDefinitionId: "wfd_agent",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { taskId: string };
    expect(typeof body.taskId).toBe("string");
    expect(runner.run).not.toHaveBeenCalled();
    expect(resolveMyraDefinitionId).not.toHaveBeenCalled();
  });

  test("agentDefinitionId omitted: dispatches through the full planner re-ask", async () => {
    const authenticator = authenticatorFor(RUN_SCOPE);
    const db = createFakeDb();
    const spawnDeps = buildSpawnDeps(db);
    const runSpy = mock(async () => ({
      content: JSON.stringify({
        kind: "task",
        use: "wfd_agent",
        refinedOutcome: "Summarize the incident",
      }),
      runId: "wfr_planner_1",
    }));
    const plannerRunDeps = buildPlannerRunDeps({ runner: { run: runSpy } });

    const app = createWorkflowDispatchRoutes({
      authenticator,
      ...spawnDeps,
      ...plannerRunDeps,
    });

    const response = await postDispatch(app, {
      outcome: "Summarize the incident",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { taskId: string };
    expect(typeof body.taskId).toBe("string");
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  test("maps a planning failure to a plain-language 422, never a raw 500", async () => {
    const authenticator = authenticatorFor(RUN_SCOPE);
    const db = createFakeDb();
    const spawnDeps = buildSpawnDeps(db);
    const plannerRunDeps = buildPlannerRunDeps({
      resolveMyraDefinitionId: mock(async () => {
        throw new PlannerMyraUnavailableError("tnt_1", "no deployed Myra");
      }),
    });

    const app = createWorkflowDispatchRoutes({
      authenticator,
      ...spawnDeps,
      ...plannerRunDeps,
    });

    const response = await postDispatch(app, {
      outcome: "Summarize the incident",
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("dispatch_failed");
  });

  test("rejects a malformed body without dispatching anything", async () => {
    const authenticator = authenticatorFor(RUN_SCOPE);
    const db = createFakeDb();
    const spawnDeps = buildSpawnDeps(db);
    const plannerRunDeps = buildPlannerRunDeps({
      runner: neverCalledRunner(),
      resolveMyraDefinitionId: neverCalledResolveMyraDefinitionId(),
    });

    const app = createWorkflowDispatchRoutes({
      authenticator,
      ...spawnDeps,
      ...plannerRunDeps,
    });

    const response = await postDispatch(app, { outcome: "" });

    expect(response.status).toBe(400);
  });
});
