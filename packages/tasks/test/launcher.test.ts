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
import { task as taskTable } from "../src/schema";
import type { TaskRecord, TaskStore } from "../src/store";
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
  PROMPT_DELIVERY_FAILED_MESSAGE,
  TaskDefinitionNotFoundError,
  TaskDefinitionNotLaunchableError,
  TaskDefinitionNotTaskableError,
} = await import("../src/launcher");

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
      workflowDefinition: {
        findFirst: async () => opts.workflowDefinitionRow,
      },
      tenant: { findFirst: async () => opts.tenantRow },
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

/**
 * A `TaskStore` view over the fake db's recorded `task` inserts — in
 * production the launcher's `persistExtra` and its read-back hit the
 * same database; this fake keeps that identity without a real one.
 */
function storeOverInserts(db: {
  inserted: { table: unknown; values: unknown }[];
}): TaskStore & { completed: { id: string; status: string }[] } {
  const statusOverride = new Map<string, "done" | "failed">();
  const resultMailIds = new Map<string, string>();
  const completed: { id: string; status: string }[] = [];
  function rows(): TaskRecord[] {
    return db.inserted
      .filter((row) => row.table === taskTable)
      .map((row) => {
        const values = row.values as TaskRecord;
        const status = statusOverride.get(values.id) ?? values.status;
        return {
          ...values,
          status,
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
    async createTask() {
      throw new Error("launchTask persists via persistExtra, never createTask");
    },
    async getTask(tenantId, id) {
      return (
        rows().find((row) => row.tenantId === tenantId && row.id === id) ?? null
      );
    },
    async getTaskByRunId(runId) {
      return rows().find((row) => row.runId === runId) ?? null;
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
      db: opts.db as never,
      sessionService: {
        async deployInstanceAtHead(params: unknown) {
          deployCalls.push(params);
          return { publicKey: "test-public-key" };
        },
        async sendUserMessage(params: unknown) {
          if (opts.sendUserMessageFails === true) {
            throw new Error("sidecar unreachable");
          }
          sendCalls.push(params);
          return new TextEncoder().encode("raw-mime-bytes");
        },
        async endSession() {},
      } as never,
      assetService: {
        async readAssetBlob() {
          return new TextEncoder().encode(JSON.stringify(AGENT_WORKFLOW_JSON));
        },
      } as never,
      sidecarRouter: {
        dispatchAgentEvent() {},
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
