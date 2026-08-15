// Mirrors packages/tasks/test/launcher.test.ts's fake-db/deps shape for
// exercising `launchTask` under the hood: `launchTask` persists the
// task row via `persistExtra` inside the launch transaction, so the
// `TaskStore` a test hands it must read that same row back — a plain
// `createMemoryTaskStore` never sees a `persistExtra` insert, since
// that insert goes through the fake db directly. `storeOverInserts`
// (copied from `launcher.test.ts`, extended with a real
// `linkPlannerRun`) is the same db-backed `TaskStore` view that test
// file uses, for the same reason.
//
// `@corbits/folded-runs`' `launchFoldedRun`/`sendFoldedMailWithRetry`
// are mocked directly here (rather than exercised for real, the way
// `launcher.test.ts` does it) because `mock.module` replaces a module
// in bun's process-wide registry for every test file in the same `bun
// test` invocation, including ones in other packages — e.g.
// `packages/folded-runs/src/one-shot-reply.test.ts` — that mock the
// same module's internals with a different fake before this file's
// own imports ever run (bun loads every test file's top-level module
// graph before running any file's tests, so a later `afterAll`
// restore in that file cannot undo the effect on modules this file
// already resolved against). Rather than depend on file load order,
// this file pins its own fake for the one call shape `launchTask`
// needs (call `persistExtra` inside the fake db's transaction, report
// success) — deliberately not the real
// `deployAtHead`/`resolveDefinitionSources` path, since that path is
// already covered by `packages/tasks/test/launcher.test.ts`.
import { describe, expect, mock, test } from "bun:test";
import { task as taskTable, taskLeg as taskLegTable } from "@corbits/tasks";
import type { TaskLegRecord, TaskRecord, TaskStore } from "@corbits/tasks";
import type { SpawnDeps } from "./spawn";

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

const {
  spawnFromTaskSpec,
  PlannerCredentialBindingUnavailableError,
  PlannerCreateBoundsViolationError,
} = await import("./spawn");

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

/** A `TaskStore` view over the fake db's recorded `task` inserts —
 * copied from `packages/tasks/test/launcher.test.ts`'s
 * `storeOverInserts`, extended with a real `linkPlannerRun` so
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
        async deployInstanceAtHead() {
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

const GRANOLA_BINDING = {
  package: "@corbits/granola-tools",
  handle: "granola",
  provider: "granola",
  locator: "tenant" as const,
};

const INVENTORY = {
  agents: [
    { id: "wfd_agent", name: "incident-bot", displayName: "Incident bot" },
  ],
  toolPackages: [
    {
      name: "@corbits/granola-tools",
      connectorId: "granola",
      credentialBinding: GRANOLA_BINDING,
    },
  ],
  skills: [{ name: "incident-review" }],
  memoryAvailable: false,
  models: [{ canonicalName: "anthropic/claude-sonnet-5" }],
};

const INPUT_BASE = {
  tenantId: "tnt_1",
  principalId: "prn_alice",
  plannerRunId: "wfr_planner_1",
  inventory: INVENTORY,
};

function allowDefinitionCreateGrant() {
  return mock(async () => undefined);
}

function neverCalledUndeploy() {
  return mock(() => {
    throw new Error("undeployAgentDefinition should never be reached");
  });
}

describe("spawnFromTaskSpec", () => {
  test("{use} branch launches directly against the named agent and links the planner run", async () => {
    const db = createFakeDb();
    const store = storeOverInserts(db);
    const deployAgentDefinition = mock(async () => ({
      definitionId: "wfd_never",
    }));

    const record = await spawnFromTaskSpec(
      {
        taskLauncherDeps: createTaskLauncherDeps(db) as never,
        store,
        deployAgentDefinition,
        requireDefinitionCreateGrant: allowDefinitionCreateGrant(),
        undeployAgentDefinition: neverCalledUndeploy(),
      },
      {
        ...INPUT_BASE,
        spec: {
          kind: "task",
          use: "wfd_agent",
          refinedOutcome: "Summarize the incident",
        },
      },
    );

    expect(record.definitionId).toBe("wfd_agent");
    expect(record.plannerRunId).toBe("wfr_planner_1");
    expect(deployAgentDefinition).not.toHaveBeenCalled();

    const stored = await store.getTask("tnt_1", record.id);
    expect(stored?.plannerRunId).toBe("wfr_planner_1");
  });

  test("{create} branch deploys a new definition first, then launches against it, then links the planner run", async () => {
    const db = createFakeDb();
    const store = storeOverInserts(db);
    const deployAgentDefinition = mock(
      async (_input: Parameters<SpawnDeps["deployAgentDefinition"]>[0]) => ({
        definitionId: "wfd_agent",
      }),
    );

    const requireDefinitionCreateGrant = allowDefinitionCreateGrant();
    const record = await spawnFromTaskSpec(
      {
        taskLauncherDeps: createTaskLauncherDeps(db) as never,
        store,
        deployAgentDefinition,
        requireDefinitionCreateGrant,
        undeployAgentDefinition: neverCalledUndeploy(),
      },
      {
        ...INPUT_BASE,
        spec: {
          kind: "task",
          create: {
            name: "Incident bot",
            systemPrompt: "You review incidents.",
            toolPackagePins: ["@corbits/granola-tools"],
            skills: ["incident-review"],
            modelPreference: "anthropic/claude-sonnet-5",
          },
          refinedOutcome: "Review the latest incident",
        },
      },
    );

    expect(requireDefinitionCreateGrant).toHaveBeenCalledWith({
      tenantId: "tnt_1",
      principalId: "prn_alice",
    });
    expect(deployAgentDefinition).toHaveBeenCalledTimes(1);
    const [call] = deployAgentDefinition.mock.calls;
    expect(call?.[0]).toMatchObject({
      tenantId: "tnt_1",
      principalId: "prn_alice",
      name: "Incident bot",
      systemPrompt: "You review incidents.",
      toolPackagePins: ["@corbits/granola-tools"],
      skills: ["incident-review"],
      model: "anthropic/claude-sonnet-5",
      credentialBindings: [GRANOLA_BINDING],
    });
    expect(call?.[0]?.handle).toMatch(/^myra-task-incident-bot-[0-9a-f]{8}$/);
    expect(record.definitionId).toBe("wfd_agent");
    expect(record.plannerRunId).toBe("wfr_planner_1");

    const stored = await store.getTask("tnt_1", record.id);
    expect(stored?.plannerRunId).toBe("wfr_planner_1");
  });

  test("{create} branch pinning a tool package absent from the offered inventory fails closed, never deploys, never launches", async () => {
    const db = createFakeDb();
    const store = storeOverInserts(db);
    const deployAgentDefinition = mock(async () => ({
      definitionId: "wfd_never",
    }));
    const requireDefinitionCreateGrant = allowDefinitionCreateGrant();

    await expect(
      spawnFromTaskSpec(
        {
          taskLauncherDeps: createTaskLauncherDeps(db) as never,
          store,
          deployAgentDefinition,
          requireDefinitionCreateGrant,
          undeployAgentDefinition: neverCalledUndeploy(),
        },
        {
          ...INPUT_BASE,
          spec: {
            kind: "task",
            create: {
              name: "Incident bot",
              systemPrompt: "You review incidents.",
              // Not in INVENTORY.toolPackages — resolveCredentialBindings'
              // own defense-in-depth lookup (validateTaskSpecAgainstInventory
              // would already have caught this upstream; this proves the
              // spawn-time check fails closed on its own too).
              toolPackagePins: ["@corbits/absent-tools"],
              skills: [],
            },
            refinedOutcome: "Review the latest incident",
          },
        },
      ),
    ).rejects.toBeInstanceOf(PlannerCredentialBindingUnavailableError);

    expect(deployAgentDefinition).not.toHaveBeenCalled();
    expect(await store.listTasks("tnt_1")).toEqual([]);
  });
});

describe("spawnFromTaskSpec — chain", () => {
  test("a chain spawns ONE task, resolving/deploying every step up front, launching only leg 1", async () => {
    const db = createFakeDb();
    const store = storeOverInserts(db);
    const deployAgentDefinition = mock(async () => ({
      definitionId: "wfd_drafter",
    }));
    const requireDefinitionCreateGrant = allowDefinitionCreateGrant();

    const record = await spawnFromTaskSpec(
      {
        taskLauncherDeps: createTaskLauncherDeps(db) as never,
        store,
        deployAgentDefinition,
        requireDefinitionCreateGrant,
        undeployAgentDefinition: neverCalledUndeploy(),
      },
      {
        ...INPUT_BASE,
        spec: {
          kind: "chain",
          steps: [
            { use: "wfd_agent", refinedOutcome: "Research the outage" },
            {
              create: {
                name: "Drafter",
                systemPrompt: "You draft memos.",
                toolPackagePins: [],
                skills: [],
              },
              refinedOutcome: "Draft a memo about the research",
            },
            { use: "wfd_reviewer", refinedOutcome: "Review the memo" },
          ],
        },
      },
    );

    expect(record.definitionId).toBe("wfd_agent");
    expect(record.stepCount).toBe(3);
    expect(record.runIds).toHaveLength(1);
    expect(record.plannerRunId).toBe("wfr_planner_1");
    expect(deployAgentDefinition).toHaveBeenCalledTimes(1);
    expect(requireDefinitionCreateGrant).toHaveBeenCalledTimes(1);

    const legs = await store.listLegs("tnt_1", record.id);
    expect(legs.map((leg) => leg.definitionId)).toEqual([
      "wfd_agent",
      "wfd_drafter",
      "wfd_reviewer",
    ]);
    expect(legs.map((leg) => leg.prompt)).toEqual([
      "Research the outage",
      "Draft a memo about the research",
      "Review the memo",
    ]);
    expect(legs[0]?.status).toBe("running");
    expect(legs[0]?.runId).toBe(record.runId);
    expect(legs[0]?.startedAt).not.toBeNull();
    expect(legs[1]?.status).toBe("pending");
    expect(legs[1]?.runId).toBeNull();
    expect(legs[2]?.status).toBe("pending");
    expect(legs[2]?.runId).toBeNull();

    const stored = await store.getTask("tnt_1", record.id);
    expect(stored?.plannerRunId).toBe("wfr_planner_1");
  });

  test("the create-grant is checked exactly once for a chain with multiple {create} steps", async () => {
    const db = createFakeDb();
    const store = storeOverInserts(db);
    let deployCalls = 0;
    const deployAgentDefinition = mock(async () => {
      deployCalls += 1;
      return { definitionId: `wfd_created_${String(deployCalls)}` };
    });
    const requireDefinitionCreateGrant = allowDefinitionCreateGrant();

    await spawnFromTaskSpec(
      {
        taskLauncherDeps: createTaskLauncherDeps(db) as never,
        store,
        deployAgentDefinition,
        requireDefinitionCreateGrant,
        undeployAgentDefinition: neverCalledUndeploy(),
      },
      {
        ...INPUT_BASE,
        spec: {
          kind: "chain",
          steps: [
            {
              create: {
                name: "Researcher",
                systemPrompt: "You research.",
                toolPackagePins: [],
                skills: [],
              },
              refinedOutcome: "Research the outage",
            },
            { use: "wfd_agent", refinedOutcome: "Summarize the research" },
            {
              create: {
                name: "Drafter",
                systemPrompt: "You draft memos.",
                toolPackagePins: [],
                skills: [],
              },
              refinedOutcome: "Draft a memo",
            },
          ],
        },
      },
    );

    expect(requireDefinitionCreateGrant).toHaveBeenCalledTimes(1);
    expect(deployAgentDefinition).toHaveBeenCalledTimes(2);
  });

  test("a failing middle step aborts the whole spawn and undeploys every definition already deployed — no partial chains", async () => {
    const db = createFakeDb();
    const store = storeOverInserts(db);
    let deployCalls = 0;
    const deployAgentDefinition = mock(async () => {
      deployCalls += 1;
      if (deployCalls === 2) {
        throw new Error("agent-directory is unavailable");
      }
      return { definitionId: `wfd_created_${String(deployCalls)}` };
    });
    const requireDefinitionCreateGrant = allowDefinitionCreateGrant();
    const undeployAgentDefinition = mock(async () => undefined);

    await expect(
      spawnFromTaskSpec(
        {
          taskLauncherDeps: createTaskLauncherDeps(db) as never,
          store,
          deployAgentDefinition,
          requireDefinitionCreateGrant,
          undeployAgentDefinition,
        },
        {
          ...INPUT_BASE,
          spec: {
            kind: "chain",
            steps: [
              {
                create: {
                  name: "Researcher",
                  systemPrompt: "You research.",
                  toolPackagePins: [],
                  skills: [],
                },
                refinedOutcome: "Research the outage",
              },
              {
                create: {
                  name: "Drafter",
                  systemPrompt: "You draft memos.",
                  toolPackagePins: [],
                  skills: [],
                },
                refinedOutcome: "Draft a memo",
              },
              {
                create: {
                  name: "Reviewer",
                  systemPrompt: "You review memos.",
                  toolPackagePins: [],
                  skills: [],
                },
                refinedOutcome: "Review the memo",
              },
            ],
          },
        },
      ),
    ).rejects.toThrow("agent-directory is unavailable");

    expect(deployAgentDefinition).toHaveBeenCalledTimes(2);
    expect(undeployAgentDefinition).toHaveBeenCalledTimes(1);
    expect(undeployAgentDefinition).toHaveBeenCalledWith({
      tenantId: "tnt_1",
      definitionId: "wfd_created_1",
    });
    expect(await store.listTasks("tnt_1")).toEqual([]);
  });

  test("a {create} step violating create bounds fails closed before any step deploys", async () => {
    const db = createFakeDb();
    const store = storeOverInserts(db);
    const deployAgentDefinition = mock(async () => ({
      definitionId: "wfd_never",
    }));

    await expect(
      spawnFromTaskSpec(
        {
          taskLauncherDeps: createTaskLauncherDeps(db) as never,
          store,
          deployAgentDefinition,
          requireDefinitionCreateGrant: allowDefinitionCreateGrant(),
          undeployAgentDefinition: neverCalledUndeploy(),
        },
        {
          ...INPUT_BASE,
          spec: {
            kind: "chain",
            steps: [
              { use: "wfd_agent", refinedOutcome: "Research the outage" },
              {
                create: {
                  name: "   ",
                  systemPrompt: "   ",
                  toolPackagePins: [],
                  skills: [],
                },
                refinedOutcome: "Draft a memo",
              },
            ],
          },
        },
      ),
    ).rejects.toBeInstanceOf(PlannerCreateBoundsViolationError);

    expect(deployAgentDefinition).not.toHaveBeenCalled();
    expect(await store.listTasks("tnt_1")).toEqual([]);
  });

  test("an all-{use} chain never consults the create-grant", async () => {
    const db = createFakeDb();
    const store = storeOverInserts(db);
    const requireDefinitionCreateGrant = allowDefinitionCreateGrant();

    const record = await spawnFromTaskSpec(
      {
        taskLauncherDeps: createTaskLauncherDeps(db) as never,
        store,
        deployAgentDefinition: mock(async () => ({
          definitionId: "wfd_never",
        })),
        requireDefinitionCreateGrant,
        undeployAgentDefinition: neverCalledUndeploy(),
      },
      {
        ...INPUT_BASE,
        spec: {
          kind: "chain",
          steps: [
            { use: "wfd_agent", refinedOutcome: "Research the outage" },
            { use: "wfd_reviewer", refinedOutcome: "Review the research" },
          ],
        },
      },
    );

    expect(record.stepCount).toBe(2);
    expect(requireDefinitionCreateGrant).not.toHaveBeenCalled();
  });

  test("a later step's unavailable credential binding fails the chain closed before any step deploys", async () => {
    const db = createFakeDb();
    const store = storeOverInserts(db);
    const deployAgentDefinition = mock(async () => ({
      definitionId: "wfd_never",
    }));

    await expect(
      spawnFromTaskSpec(
        {
          taskLauncherDeps: createTaskLauncherDeps(db) as never,
          store,
          deployAgentDefinition,
          requireDefinitionCreateGrant: allowDefinitionCreateGrant(),
          undeployAgentDefinition: neverCalledUndeploy(),
        },
        {
          ...INPUT_BASE,
          spec: {
            kind: "chain",
            steps: [
              {
                create: {
                  name: "Researcher",
                  systemPrompt: "You research.",
                  toolPackagePins: [],
                  skills: [],
                },
                refinedOutcome: "Research the outage",
              },
              {
                create: {
                  name: "Drafter",
                  systemPrompt: "You draft memos.",
                  toolPackagePins: ["@corbits/absent-tools"],
                  skills: [],
                },
                refinedOutcome: "Draft a memo",
              },
            ],
          },
        },
      ),
    ).rejects.toBeInstanceOf(PlannerCredentialBindingUnavailableError);

    expect(deployAgentDefinition).not.toHaveBeenCalled();
    expect(await store.listTasks("tnt_1")).toEqual([]);
  });
});
