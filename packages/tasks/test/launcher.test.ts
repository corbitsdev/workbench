// Exercises `launchTask` end to end against fakes for every port the
// real flow touches — the drizzle handle, the session/asset services,
// the sidecar router — with `resolveDefinitionSources` mocked at the
// module boundary exactly the way
// packages/chat/test/platform-adapter.test.ts mocks it (the fake db
// has no catalog to resolve against). Covers the happy path, every
// launcher-owned error path, the prompt-delivery-exhaustion settle
// (failed task + honest inbox item, never a throw over a committed
// row), and that a picked model preference reaches source resolution.
import { describe, expect, mock, test } from "bun:test";

import type { DefinitionSourceResolution } from "@intx/hub-api";
import { task as taskTable, taskLeg as taskLegTable } from "../src/schema";
import type { TaskLegRecord, TaskRecord, TaskStore } from "../src/store";
import type { NotifyDeliveryDeps, NotifyInboxItem } from "@corbits/notify";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
} from "@corbits/notify";

const actualHubApi = await import("@intx/hub-api");

const resolveDefinitionSourcesCalls: {
  fallbackModel: string | null;
}[] = [];
const resolveDefinitionSourcesResult: DefinitionSourceResolution = {
  ok: true,
  sources: [
    {
      id: "off_1",
      provider: "anthropic",
      baseURL: "https://inference.invalid",
      apiKey: "placeholder",
      model: "claude-sonnet-5",
    },
  ],
  defaultSource: "off_1",
};

mock.module("@intx/hub-api", () => ({
  ...actualHubApi,
  resolveDefinitionSources: async (args: { fallbackModel: string | null }) => {
    resolveDefinitionSourcesCalls.push({ fallbackModel: args.fallbackModel });
    return resolveDefinitionSourcesResult;
  },
}));

const {
  launchTask,
  launchTaskLeg,
  PROMPT_DELIVERY_FAILED_MESSAGE,
  TaskDefinitionNotFoundError,
  TaskDefinitionNotLaunchableError,
  TaskDefinitionNotTaskableError,
} = await import("../src/launcher");

// The inert wire projection the deploy freeze persists onto the
// definition's version row — the launch body's only hub-side source
// under the `workflow.json` retirement.
const AGENT_WIRE_PROJECTION = {
  id: "wfd_agent",
  triggers: [],
  stepOrder: ["agent"],
  steps: {
    agent: {
      kind: "step",
      agent: {
        systemPrompt: "You summarize incidents.",
        modelSources: [
          { provider: "anthropic", model: "declared-default-model" },
        ],
      },
    },
  },
};

const selectChain = {
  from: () => selectChain,
  innerJoin: () => selectChain,
  where: () => selectChain,
  limit: async () => [
    { wireProjection: AGENT_WIRE_PROJECTION, assetId: "ast_agent" },
  ],
};

type InsertChain = {
  onConflictDoNothing(): InsertChain;
  returning(): Promise<unknown[]>;
};

function createFakeDb(opts: {
  workflowDefinitionRow?:
    | {
        id: string;
        tenantId: string;
        status: string;
        assetId: string | null;
        name: string;
      }
    | undefined;
  tenantRow?: { id: string; domain: string } | undefined;
}) {
  const deleted: { table: unknown }[] = [];
  const inserted: { table: unknown; values: unknown }[] = [];
  const updated: { table: unknown; values: unknown }[] = [];
  function updateOn(table: unknown, values: unknown) {
    updated.push({ table, values });
    return {
      where: () => ({ returning: async () => [{ id: "tleg_1" }] }),
    };
  }
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
    deleted,
    updated,
    query: {
      workflowDefinition: {
        findFirst: async () => opts.workflowDefinitionRow,
      },
      tenant: { findFirst: async () => opts.tenantRow },
    },
    // The drizzle SELECT chains the launch path runs: the definition
    // version row's stored projection (`loadFrozenWireProjection`) and
    // the run's definition asset id (`resolveRunDefinitionAssetId`).
    // One chainable stub answers both; each caller reads only its own
    // column off the single row.
    select: () => selectChain,
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
        update(table: unknown) {
          return { set: (values: unknown) => updateOn(table, values) };
        },
        delete(table: unknown) {
          deleted.push({ table });
          return { where: async () => undefined };
        },
      });
    },
  };
}

/**
 * A `TaskStore` view over the fake db's recorded `task` inserts — in
 * production the launcher's `persistExtra` and its read-back hit the
 * same database; this fake keeps that identity without a real one.
 */
function storeOverInserts(db: {
  inserted: { table: unknown; values: unknown }[];
}): TaskStore & {
  completed: { id: string; status: string }[];
  confirmedLegs: string[];
} {
  const statusOverride = new Map<string, "done" | "failed">();
  const resultMailIds = new Map<string, string>();
  const completed: { id: string; status: string }[] = [];
  const confirmedLegs: string[] = [];
  function legRows(): TaskLegRecord[] {
    return db.inserted
      .filter((row) => row.table === taskLegTable)
      .flatMap((row) => row.values as TaskLegRecord[])
      .sort((a, b) => a.position - b.position);
  }
  function legsOf(taskId: string): TaskLegRecord[] {
    return legRows().filter((leg) => leg.taskId === taskId);
  }
  function rows(): TaskRecord[] {
    return db.inserted
      .filter((row) => row.table === taskTable)
      .map((row) => {
        const values = row.values as Omit<TaskRecord, "runIds" | "stepCount">;
        const status = statusOverride.get(values.id) ?? values.status;
        const legs = legsOf(values.id);
        return {
          ...values,
          status,
          runIds: legs
            .map((leg) => leg.runId)
            .filter((runId): runId is string => runId !== null),
          stepCount: legs.length,
          resultMailId: resultMailIds.get(values.id) ?? values.resultMailId,
          completedAt:
            statusOverride.has(values.id) && values.completedAt === null
              ? new Date()
              : values.completedAt,
        };
      });
  }
  return {
    completed,
    confirmedLegs,
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
    async completeTask(input) {
      const row = rows().find(
        (candidate) =>
          candidate.tenantId === input.tenantId && candidate.id === input.id,
      );
      if (row === null || row === undefined || row.status !== "running") {
        return null;
      }
      statusOverride.set(input.id, input.status);
      completed.push({ id: input.id, status: input.status });
      const [updated] = rows().filter((candidate) => candidate.id === input.id);
      return updated ?? null;
    },
    async recordResultMail(input) {
      resultMailIds.set(input.id, input.resultMailId);
    },
    async linkPlannerRun() {
      throw new Error("launchTask never calls linkPlannerRun");
    },
    async recordWorkbench() {
      throw new Error("launchTask never calls recordWorkbench");
    },
    async listLegs(tenantId, taskId) {
      return legsOf(taskId).filter((leg) => leg.tenantId === tenantId);
    },
    async getLegByRunId(runId) {
      return legRows().find((leg) => leg.runId === runId) ?? null;
    },
    async claimLegDispatch() {
      throw new Error("launchTask never claims a hand-off leg");
    },
    async recordLegRun() {
      throw new Error("launchTask records its own leg run in the launch tx");
    },
    async confirmLegDelivery(input) {
      confirmedLegs.push(input.legId);
      const startedAt = new Date();
      return {
        id: input.legId,
        taskId: "task_1",
        tenantId: input.tenantId,
        position: 1,
        definitionId: "wfd_agent",
        prompt: "Continue the work.",
        modelPreference: null,
        parentRunId: "run_leg0",
        messageId: "chain:task_1:1",
        runId: "run_leg1",
        status: "running",
        leaseExpiresAt: null,
        errorMessage: null,
        createdAt: startedAt,
        startedAt,
        settledAt: null,
      };
    },
    async listStuckLegDispatches() {
      throw new Error("the launcher never sweeps stuck hand-offs");
    },
    async settleLeg() {
      throw new Error("launchTask never settles a leg");
    },
    async failLegDispatch() {
      throw new Error("launchTask never fails a hand-off leg");
    },
  };
}

function fakeNotify(): {
  readonly deps: NotifyDeliveryDeps;
  readonly delivered: readonly NotifyInboxItem[][];
} {
  const delivered: NotifyInboxItem[][] = [];
  return {
    deps: {
      mail: async (items, opts) => {
        delivered.push([...items]);
        return items.map((item, index) => {
          const id = `mail_${String(delivered.length)}_${String(index)}`;
          opts?.enqueue?.({ id, item });
          return { messageKey: `key_${String(index)}`, id };
        });
      },
      addressing: {
        inbox: (recipient) => `${recipient.principalId}@inbox.test`,
        from: (kind) => `${kind}@notify.test`,
      },
      dispatch: createInMemoryNotifyDispatchStore(),
      sinks: createSinkRegistry(),
    },
    delivered,
  };
}

function createDeps(opts: {
  db: ReturnType<typeof createFakeDb>;
  sendUserMessageFails?: boolean;
  isTaskable?: boolean;
}) {
  const deployCalls: unknown[] = [];
  const sendCalls: unknown[] = [];
  const store = storeOverInserts(opts.db);
  const notify = fakeNotify();
  const deps = {
    db: opts.db as never,
    store,
    foldedRuns: {
      toolGrantsForPins: () => [],
      db: opts.db as never,
      sessionService: {
        async sendUserMessage(params: unknown) {
          if (opts.sendUserMessageFails === true) {
            throw new Error("sidecar unreachable");
          }
          sendCalls.push(params);
          return new TextEncoder().encode("raw-mime-bytes");
        },
        async endSession() {},
        // The step deploy tree the sidecar's tool loader reads a run's
        // pinned tool-package closure from; source-ref deploys stage it
        // explicitly (see `deployAtHead`).
        async stageWorkflowStep() {},
        // The adopting code-sourced front `deployAtHead` uses: a folded
        // run's anchor row is minted before any deployment attaches.
        async deployAdoptedWorkflowFromSource(params: unknown) {
          deployCalls.push(params);
          return { publicKey: "test-public-key" };
        },
      } as never,
      assetService: {
        async populateAsset() {
          return { commitSha: "sha_deploy" };
        },
      } as never,
      sidecarRouter: {
        dispatchAgentEvent() {},
        // A task's run is born through `launchFoldedRun`, which produces the
        // run's `run.grants` frame once the deploy acks.
        sendRunGrants() {
          return true;
        },
      } as never,
      eventCollectors: {
        create() {},
        abandon() {},
      } as never,
    },
    cryptoProviders: {
      async get() {
        return {} as never;
      },
    },
    notify: notify.deps,
    isTaskableDefinition: () => opts.isTaskable ?? true,
  };
  return { deps, store, notify, deployCalls, sendCalls };
}

const DEPLOYED_DEFINITION = {
  id: "wfd_agent",
  tenantId: "tnt_1",
  status: "deployed",
  assetId: "ast_1",
  name: "incident-bot",
};
const TENANT = { id: "tnt_1", domain: "acme.example" };

const INPUT = {
  tenantId: "tnt_1",
  principalId: "prn_alice",
  definitionId: "wfd_agent",
  prompt: "Summarize the incident.",
};

describe("launchTask", () => {
  test("happy path: launches, persists the task row in the launch transaction, sends the prompt, returns the running record", async () => {
    const db = createFakeDb({
      workflowDefinitionRow: DEPLOYED_DEFINITION,
      tenantRow: TENANT,
    });
    const { deps, deployCalls, sendCalls } = createDeps({ db });

    const record = await launchTask(deps as never, INPUT);

    expect(record.status).toBe("running");
    expect(record.prompt).toBe("Summarize the incident.");
    expect(record.principalId).toBe("prn_alice");
    expect(deployCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(1);
    const taskInserts = db.inserted.filter((row) => row.table === taskTable);
    expect(taskInserts).toHaveLength(1);
  });

  test("an unknown definition throws TaskDefinitionNotFoundError before anything launches", async () => {
    const db = createFakeDb({
      workflowDefinitionRow: undefined,
      tenantRow: TENANT,
    });
    const { deps, deployCalls } = createDeps({ db });

    await expect(launchTask(deps as never, INPUT)).rejects.toBeInstanceOf(
      TaskDefinitionNotFoundError,
    );
    expect(deployCalls).toHaveLength(0);
    expect(db.inserted).toHaveLength(0);
  });

  test("an undeployed definition throws TaskDefinitionNotLaunchableError", async () => {
    const db = createFakeDb({
      workflowDefinitionRow: { ...DEPLOYED_DEFINITION, status: "draft" },
      tenantRow: TENANT,
    });
    const { deps } = createDeps({ db });

    await expect(launchTask(deps as never, INPUT)).rejects.toBeInstanceOf(
      TaskDefinitionNotLaunchableError,
    );
  });

  test("an unmaterialized definition throws TaskDefinitionNotLaunchableError", async () => {
    const db = createFakeDb({
      workflowDefinitionRow: { ...DEPLOYED_DEFINITION, assetId: null },
      tenantRow: TENANT,
    });
    const { deps } = createDeps({ db });

    await expect(launchTask(deps as never, INPUT)).rejects.toBeInstanceOf(
      TaskDefinitionNotLaunchableError,
    );
  });

  test("a non-taskable definition throws TaskDefinitionNotTaskableError", async () => {
    const db = createFakeDb({
      workflowDefinitionRow: DEPLOYED_DEFINITION,
      tenantRow: TENANT,
    });
    const { deps } = createDeps({ db, isTaskable: false });

    await expect(launchTask(deps as never, INPUT)).rejects.toBeInstanceOf(
      TaskDefinitionNotTaskableError,
    );
  });

  test("exhausted prompt delivery settles the task as failed with an honest inbox item — never a throw over a committed row", async () => {
    const db = createFakeDb({
      workflowDefinitionRow: DEPLOYED_DEFINITION,
      tenantRow: TENANT,
    });
    const { deps, store, notify } = createDeps({
      db,
      sendUserMessageFails: true,
    });

    const record = await launchTask(deps as never, INPUT);

    expect(record.status).toBe("failed");
    expect(store.completed).toEqual([{ id: record.id, status: "failed" }]);
    expect(notify.delivered).toHaveLength(1);
    expect(notify.delivered[0]?.[0]?.body).toContain(
      PROMPT_DELIVERY_FAILED_MESSAGE,
    );
    expect(record.resultMailId).not.toBeNull();
  });

  test("a task row the launch transaction failed to persist is a loud error, not a silent success", async () => {
    const db = createFakeDb({
      workflowDefinitionRow: DEPLOYED_DEFINITION,
      tenantRow: TENANT,
    });
    const { deps } = createDeps({ db });
    // Sever the read-back: the store no longer sees the launch's own insert.
    (deps.store as { getTaskByRunId: unknown }).getTaskByRunId = async () =>
      null;

    await expect(launchTask(deps as never, INPUT)).rejects.toThrow(
      /was not persisted/,
    );
  });

  test("a picked model preference pins source resolution; none means the declared model", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    const db = createFakeDb({
      workflowDefinitionRow: DEPLOYED_DEFINITION,
      tenantRow: TENANT,
    });
    const { deps } = createDeps({ db });
    await launchTask(deps as never, {
      ...INPUT,
      modelPreference: "anthropic/claude-opus",
    });
    expect(resolveDefinitionSourcesCalls[0]?.fallbackModel).toBe(
      "anthropic/claude-opus",
    );

    const db2 = createFakeDb({
      workflowDefinitionRow: DEPLOYED_DEFINITION,
      tenantRow: TENANT,
    });
    const second = createDeps({ db: db2 });
    await launchTask(second.deps as never, INPUT);
    expect(resolveDefinitionSourcesCalls[1]?.fallbackModel).toBe(
      "declared-default-model",
    );
  });
});

const LEG_INPUT = {
  tenantId: "tnt_1",
  principalId: "prn_alice",
  legId: "tleg_1",
  definitionId: "wfd_agent",
  prompt: "Continue the work.",
  modelPreference: null,
};

describe("launchTaskLeg", () => {
  test("the run id is recorded in the launch transaction, but the leg only starts once its prompt is delivered", async () => {
    const db = createFakeDb({
      workflowDefinitionRow: DEPLOYED_DEFINITION,
      tenantRow: TENANT,
    });
    const { deps, store, sendCalls } = createDeps({ db });

    const runId = await launchTaskLeg(deps as never, LEG_INPUT);

    // The transaction records the run and nothing else: the leg is
    // still claimed, not started, because the prompt has not been
    // delivered at the point it commits.
    const stamp = db.updated.find((row) => row.table === taskLegTable)?.values;
    expect(stamp).toEqual({ runId });
    expect(sendCalls).toHaveLength(1);
    expect(store.confirmedLegs).toEqual(["tleg_1"]);
  });

  test("a prompt that cannot be delivered throws and leaves the leg unstarted", async () => {
    const db = createFakeDb({
      workflowDefinitionRow: DEPLOYED_DEFINITION,
      tenantRow: TENANT,
    });
    const { deps, store } = createDeps({ db, sendUserMessageFails: true });

    await expect(launchTaskLeg(deps as never, LEG_INPUT)).rejects.toThrow(
      /couldn't be delivered/,
    );

    // Nothing marked this leg as started, so the chain's own failure
    // path still finds a claimed leg it can fail honestly.
    expect(store.confirmedLegs).toEqual([]);
  });
});
