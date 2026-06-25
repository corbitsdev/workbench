import { describe, expect, it, mock } from "bun:test";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

// --- Module-boundary mocks for the title-generation inference path ---

let lastCreateEventCollectorConfig: {
  instanceId: string;
  tenantId: string;
  sessionId: string;
} | null = null;
let collectorEvents: { type: string }[] = [];
let agentReply = "Pricing Deep Dive";
let agentShouldThrow = false;
let lastIsogitDir: string | null = null;

function resetTitleMocks() {
  lastCreateEventCollectorConfig = null;
  collectorEvents = [];
  agentReply = "Pricing Deep Dive";
  agentShouldThrow = false;
  lastIsogitDir = null;
}

mock.module("@workbench/storage-isogit", () => ({
  createIsogitStore: mock((dir: string) => {
    lastIsogitDir = dir;
    return Promise.resolve({});
  }),
}));

mock.module("@workbench/event-collector", () => ({
  createEventCollector: mock(
    (config: {
      instanceId: string;
      tenantId: string;
      sessionId: string;
      onTurnFinalized?: (turn: unknown) => void;
    }) => {
      lastCreateEventCollectorConfig = {
        instanceId: config.instanceId,
        tenantId: config.tenantId,
        sessionId: config.sessionId,
      };
      return {
        onEvent: mock((event: { type: string }) => {
          collectorEvents.push(event);
          if (event.type === "inference.done" && config.onTurnFinalized) {
            config.onTurnFinalized({
              turnId: "t1",
              status: "completed",
              text: agentReply,
            });
          }
          return Promise.resolve();
        }),
        abandon: mock(() => Promise.resolve()),
        getAccumulatedText: () => agentReply,
        getCurrentTurnId: () => null,
        getLastTurnId: () => "t1",
      };
    },
  ),
}));

mock.module("@intx/agent", () => ({
  defineAgent: mock((def: unknown) => def),
  createDefaultDirectorRegistry: mock(() => ({})),
  createAgent: mock(() =>
    Promise.resolve({
      async *stream() {
        yield { type: "inference.start", data: { model: "m" } };
        yield { type: "inference.done", data: { turn: { content: [] } } };
        yield { type: "message.received", data: {} };
      },
      send: mock(() => {
        if (agentShouldThrow)
          return Promise.reject(new Error("inference boom"));
        return Promise.resolve({ reply: agentReply });
      }),
      close: mock(() => Promise.resolve()),
    }),
  ),
}));

const resolveCredentialRequirementMock = mock(() => Promise.resolve(null));
mock.module("@intx/db", () => ({
  schema: {
    agent: { tenantId: "agent.tenantId", name: "agent.name" },
    agentInstance: {},
    agentSession: {},
    principal: {},
    grant: {},
  },
  resolveCredentialRequirement: resolveCredentialRequirementMock,
}));

mock.module("../config", () => ({
  getConfig: () => ({
    hub: { dataDir: "/tmp/myra-title-test" },
    rootTenant: { slug: "global", domain: "global.test" },
  }),
}));

let launchShouldThrow: unknown = null;
const launchAgentSessionMock = mock(() => {
  if (launchShouldThrow !== null) return Promise.reject(launchShouldThrow);
  return Promise.resolve({ address: "a", sessionId: "s" });
});
mock.module("./agent-provisioning", () => ({
  resolveInstanceSourcesFromDefinition: mock(() =>
    Promise.resolve({
      ok: true,
      sources: [
        {
          id: "ofr_1",
          provider: "openai-compatible",
          baseURL: "https://llm.example/v1",
          apiKey: "sk-myra",
          model: "gpt-4o",
        },
      ],
    }),
  ),
  launchAgentSession: launchAgentSessionMock,
  describeLaunchError: (err: unknown) => ({
    phase: null,
    detail: err instanceof Error ? err.message : String(err),
  }),
}));

import {
  createMyraThread,
  deleteMyraThread,
  generateMyraThreadTitle,
  listMyraThreads,
  MyraThreadLaunchError,
  renameMyraThread,
} from "./myra-threads";

describe("createMyraThread", () => {
  function buildCreateDb(opts: {
    transactions: () => void;
    deleted?: unknown[];
  }) {
    return {
      query: {
        agent: {
          findFirst: mock(() =>
            Promise.resolve({ id: "agt-myra", systemPrompt: "You are Myra." }),
          ),
        },
        memberAgentInstance: { findMany: mock(() => Promise.resolve([])) },
      },
      transaction: mock(async (fn: (tx: unknown) => Promise<void>) => {
        opts.transactions();
        await fn({
          insert: () => ({ values: () => Promise.resolve(undefined) }),
          delete: (table: unknown) => {
            opts.deleted?.push(table);
            return { where: () => Promise.resolve(undefined) };
          },
        });
      }),
    };
  }

  const deps = {
    // biome-ignore lint/suspicious/noExplicitAny: structural mock
    sessionService: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: structural mock
    grantStore: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: structural mock
    eventCollectors: {} as any,
  };

  it("returns created:true when the session launches", async () => {
    launchShouldThrow = null;
    let txCount = 0;
    const db = buildCreateDb({ transactions: () => (txCount += 1) });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await createMyraThread(db as any, deps, {
      tenantId: "tn-global",
      tenantDomain: "global.test",
      memberPrincipalId: "prn-member",
    });

    expect(result.created).toBe(true);
    expect(launchAgentSessionMock).toHaveBeenCalled();
    // Only the create transaction ran — no teardown.
    expect(txCount).toBe(1);
  });

  it("throws MyraThreadLaunchError and tears down the rows when the launch fails", async () => {
    launchShouldThrow = new Error(
      'Source provider "granola" is not registered',
    );
    let txCount = 0;
    const deleted: unknown[] = [];
    const db = buildCreateDb({ transactions: () => (txCount += 1), deleted });

    let thrown: unknown;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: structural db mock
      await createMyraThread(db as any, deps, {
        tenantId: "tn-global",
        tenantDomain: "global.test",
        memberPrincipalId: "prn-member",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MyraThreadLaunchError);
    expect((thrown as MyraThreadLaunchError).detail).toContain("granola");
    // The create transaction AND the teardown transaction both ran, so no
    // orphan thread row survives a failed launch.
    expect(txCount).toBe(2);
    // Teardown deletes five rows: grant, member mapping, instance, the lingering
    // agent_session, then the principal. The agent_session delete is the
    // load-bearing one — without it the principal delete FK-violates (RESTRICT)
    // and the rollback leaves the orphan it exists to remove. A count of 5 (not
    // 4) is what guards that delete from being dropped. (The agents.ts rollback
    // test pins the FK-dictated session→principal ordering by table identity.)
    expect(deleted).toHaveLength(5);
    // Pin the deletes by drizzle table name so a future change that drops the
    // agent_session or principal delete — but adds an extra delete elsewhere,
    // keeping the count at 5 — still fails here. getTableName reads the real
    // table identity, so this asserts the actual rows torn down, not the count.
    const deletedNames = deleted.map((d) => getTableName(d as PgTable));
    expect(deletedNames).toContain("agent_session");
    expect(deletedNames).toContain("principal");
  });
});

describe("generateMyraThreadTitle", () => {
  function buildTitleDb(opts: {
    mappingRow:
      | { id: string; instanceId: string; label: string | null }
      | undefined;
    renamed?: {
      id: string;
      instanceId: string;
      label: string;
      createdAt: Date;
    };
  }) {
    const updateReturning = mock(() =>
      Promise.resolve(opts.renamed ? [opts.renamed] : []),
    );
    return {
      query: {
        memberAgentInstance: {
          findFirst: mock(() => Promise.resolve(opts.mappingRow)),
        },
        agent: {
          findFirst: mock(() =>
            Promise.resolve({ id: "agt", modelRequirements: null }),
          ),
        },
        provider: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
      update: mock(() => ({
        set: () => ({ where: () => ({ returning: updateReturning }) }),
      })),
    };
  }

  it("titles a default-labelled thread and records the turn under its instance", async () => {
    resetTitleMocks();
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat" },
      renamed: {
        id: "map-1",
        instanceId: "inst-1",
        label: "Pricing Deep Dive",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(
      db as any,
      {},
      {
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        threadId: "map-1",
        firstMessage: "How should we price the enterprise tier?",
      },
    );

    expect(result).toEqual({
      id: "map-1",
      instanceId: "inst-1",
      label: "Pricing Deep Dive",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // The turn was recorded under the thread's instance + tenant.
    expect(lastCreateEventCollectorConfig?.instanceId).toBe("inst-1");
    expect(lastCreateEventCollectorConfig?.tenantId).toBe("tn-global");
    // Events were actually pumped into the collector (and message.received filtered).
    expect(collectorEvents.map((e) => e.type)).toEqual([
      "inference.start",
      "inference.done",
    ]);
  });

  it("no-ops on a custom (non-default) label without running inference", async () => {
    resetTitleMocks();
    const db = buildTitleDb({
      mappingRow: {
        id: "map-1",
        instanceId: "inst-1",
        label: "Existing Title",
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(
      db as any,
      {},
      {
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        threadId: "map-1",
        firstMessage: "Hello",
      },
    );

    expect(result).toBeNull();
    expect(lastCreateEventCollectorConfig).toBeNull();
  });

  it("returns null when the mapping is not found", async () => {
    resetTitleMocks();
    const db = buildTitleDb({ mappingRow: undefined });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(
      db as any,
      {},
      {
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        threadId: "missing",
        firstMessage: "Hello",
      },
    );

    expect(result).toBeNull();
  });

  it("does not throw and returns null when inference fails", async () => {
    resetTitleMocks();
    agentShouldThrow = true;
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "Chat 2" },
    });

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(
      db as any,
      {},
      {
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        threadId: "map-1",
        firstMessage: "Hello",
      },
    );

    expect(result).toBeNull();
  });

  it("sanitizes the model output before persisting it", async () => {
    resetTitleMocks();
    agentReply = '  "Pricing  Strategy."  \n';
    let persistedLabel = "";
    const db = buildTitleDb({
      mappingRow: { id: "map-1", instanceId: "inst-1", label: "" },
      renamed: {
        id: "map-1",
        instanceId: "inst-1",
        label: "Pricing Strategy",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    // Capture the label handed to update().set().
    db.update = mock(() => ({
      set: (vals: { label: string }) => {
        persistedLabel = vals.label;
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  id: "map-1",
                  instanceId: "inst-1",
                  label: vals.label,
                  createdAt: new Date("2026-01-01T00:00:00Z"),
                },
              ]),
          }),
        };
      },
    })) as never;

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await generateMyraThreadTitle(
      db as any,
      {},
      {
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        threadId: "map-1",
        firstMessage: "pricing?",
      },
    );

    expect(persistedLabel).toBe("Pricing Strategy");
    expect(result?.label).toBe("Pricing Strategy");
    // Durable audit repo lives under the hub dataDir, keyed per (tenant, principal).
    expect(lastIsogitDir).toBe(
      "/tmp/myra-title-test/myra-title/tn-global/prn-member",
    );
  });

  it("returns null when firstMessage is blank without touching the db", async () => {
    resetTitleMocks();
    const findFirst = mock(() => Promise.resolve(undefined));
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = { query: { memberAgentInstance: { findFirst } } };

    const result = await generateMyraThreadTitle(
      db,
      {},
      {
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        threadId: "map-1",
        firstMessage: "   ",
      },
    );

    expect(result).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("listMyraThreads", () => {
  it("maps rows and falls back to default labels by position", async () => {
    const rows = [
      {
        id: "map-1",
        instanceId: "inst-1",
        label: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "map-2",
        instanceId: "inst-2",
        label: "  ",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: "map-3",
        instanceId: "inst-3",
        label: "Pricing deep dive",
        createdAt: new Date("2026-01-03T00:00:00Z"),
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = {
      query: {
        memberAgentInstance: { findMany: mock(() => Promise.resolve(rows)) },
      },
    };

    const threads = await listMyraThreads(db, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
    });

    expect(threads).toEqual([
      {
        id: "map-1",
        instanceId: "inst-1",
        label: "Chat",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "map-2",
        instanceId: "inst-2",
        label: "Chat 2",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "map-3",
        instanceId: "inst-3",
        label: "Pricing deep dive",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ]);
  });
});

describe("renameMyraThread", () => {
  it("returns the mapped row when a row is updated", async () => {
    const returning = mock(() =>
      Promise.resolve([
        {
          id: "map-1",
          instanceId: "inst-1",
          label: "New label",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ]),
    );
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = {
      update: mock(() => ({ set: () => ({ where: () => ({ returning }) }) })),
    };

    const result = await renameMyraThread(db, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      label: "  New label  ",
    });

    expect(result).toEqual({
      id: "map-1",
      instanceId: "inst-1",
      label: "New label",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(returning).toHaveBeenCalled();
  });

  it("returns null when no row matched", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = {
      update: mock(() => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([]) }),
        }),
      })),
    };

    const result = await renameMyraThread(db, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-x",
      label: "New label",
    });

    expect(result).toBeNull();
  });

  it("returns null without touching the db when the label is empty", async () => {
    const update = mock(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    }));
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const db: any = { update };

    const result = await renameMyraThread(db, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
      label: "   ",
    });

    expect(result).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("deleteMyraThread", () => {
  function buildDeleteDb(
    mappingRow: unknown,
    instanceRow: unknown,
    deleteSpy: () => void,
  ) {
    return {
      query: {
        memberAgentInstance: {
          findFirst: mock(() => Promise.resolve(mappingRow)),
        },
        agentInstance: { findFirst: mock(() => Promise.resolve(instanceRow)) },
      },
      transaction: mock(async (fn: (tx: unknown) => Promise<void>) => {
        await fn({
          delete: () => {
            deleteSpy();
            return { where: () => Promise.resolve(undefined) };
          },
        });
      }),
    };
  }

  it("ends the session, deletes the rows, and returns true", async () => {
    let deletes = 0;
    const db = buildDeleteDb(
      { id: "map-1", instanceId: "inst-1" },
      { id: "inst-1", address: "inst-1@myra.test", principalId: "prn-inst-1" },
      () => {
        deletes += 1;
      },
    );
    const endSession = mock(() => Promise.resolve());
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const deps: any = { sessionService: { endSession } };

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await deleteMyraThread(db as any, deps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-1",
    });

    expect(result).toBe(true);
    expect(endSession).toHaveBeenCalledWith(
      "inst-1@myra.test",
      "myra_thread_deleted",
    );
    // grant, member mapping, instance, agent_session, principal.
    expect(deletes).toBe(5);
  });

  it("returns false and skips teardown when the mapping is not found", async () => {
    const db = buildDeleteDb(undefined, undefined, () => {});
    const endSession = mock(() => Promise.resolve());
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const deps: any = { sessionService: { endSession } };

    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const result = await deleteMyraThread(db as any, deps, {
      tenantId: "tn-global",
      memberPrincipalId: "prn-member",
      threadId: "map-x",
    });

    expect(result).toBe(false);
    expect(endSession).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("throws (no silent no-op teardown) when the instance has no principalId", async () => {
    const db = buildDeleteDb(
      { id: "map-1", instanceId: "inst-1" },
      { id: "inst-1", address: "inst-1@myra.test" },
      () => {},
    );
    const endSession = mock(() => Promise.resolve());
    // biome-ignore lint/suspicious/noExplicitAny: structural db mock
    const deps: any = { sessionService: { endSession } };

    let thrown: unknown;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: structural db mock
      await deleteMyraThread(db as any, deps, {
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        threadId: "map-1",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("no principalId");
    // It must fail before tearing anything down — a partial delete with an
    // empty principalId is exactly the orphan this guards against.
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
