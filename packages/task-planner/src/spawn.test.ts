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

const { spawnFromTaskSpec, PlannerCredentialBindingUnavailableError } =
  await import("./spawn");

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
