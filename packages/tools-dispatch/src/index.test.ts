// Behavioral tests for the dispatch tool.
//
// The Interchange boundary modules are mocked via mock.module so we can drive
// the dispatch handler directly and assert its real orchestration behavior:
// instance + principal + session persistence, source/grant resolution, launch,
// caller-address resolution, and the user-message send. The DispatchContext
// (db, sessionService, eventCollectors, buildToolDefinitions) is injected as an
// argument — it is the package's public surface, not a module boundary — so we
// pass a recording fake there rather than mocking it as a module.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// bun's `mock.module` is process-global, so the partial mocks below would
// otherwise bleed into sibling test files (e.g. interchange-tools.test.ts):
// their graphs import the real `drizzle-orm` / `@intx/crypto-node` and would
// hit a partial mock missing exports like `desc` / `armorEncode`. Spread the
// real modules so the mocks override only the specific exports under test.
const realDrizzle = await import("drizzle-orm");
const realCrypto = await import("@intx/crypto-node");

let idCounter = 0;
mock.module("@intx/hub-common", () => ({
  generateId: (prefix: string) => `${prefix}_${++idCounter}`,
}));

const logCalls: { message: string; meta: unknown }[] = [];
mock.module("@intx/log", () => ({
  getLogger: () => ({
    info: (message: string, meta: unknown) => {
      logCalls.push({ message, meta });
    },
    error: () => {},
    warn: () => {},
    debug: () => {},
  }),
}));

// drizzle-orm's and/eq build SQL predicates; in tests they only need to be
// opaque tokens since the fake db ignores `where` and serves programmed rows.
mock.module("drizzle-orm", () => ({
  ...realDrizzle,
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
}));

// resolveInstanceModelSources and createGrantStore are configurable per-test
// via these mutable hooks; the schema is a plain marker object since predicates
// are opaque. An empty source array maps to a failed resolution.
let resolveSourcesImpl: () => Promise<{ id: string }[]>;
let collectGrantsImpl: () => Promise<unknown[]>;
mock.module("@intx/db", () => ({
  schema: {
    tenant: { id: "tenant.id" },
    principal: {},
    agent: { id: "agent.id", tenantId: "agent.tenantId" },
    agentInstance: {
      id: "ai.id",
      principalId: "ai.principalId",
      tenantId: "ai.tenantId",
    },
    agentSession: { id: "as.id" },
    grant: { principalId: "grant.principalId", origin: "grant.origin" },
  },
  resolveInstanceModelSources: async () => {
    const sources = await resolveSourcesImpl();
    if (sources.length === 0) return { ok: false, reason: "no_requirements" };
    return { ok: true, sources };
  },
  createGrantStore: () => ({ collectGrants: () => collectGrantsImpl() }),
}));

let generateKeyPairCalls = 0;
mock.module("@intx/crypto-node", () => ({
  ...realCrypto,
  generateKeyPair: async () => {
    generateKeyPairCalls += 1;
    return { publicKey: "pub", privateKey: "priv" };
  },
  createNodeCrypto: (kp: unknown) => ({ _crypto: kp }),
}));

const { createDispatchTools, DISPATCH_HUB_TOOLS, DISPATCH_AGENT_DEFINITION } =
  await import("./index");

type DbOp =
  | { kind: "insert"; table: unknown; values: unknown }
  | { kind: "update"; table: unknown; set: unknown }
  | { kind: "delete"; table: unknown };

type FakeDbConfig = {
  tenantRow?: { domain?: string } | null;
  agentRow?: Record<string, unknown> | null;
  callerInstance?: { address?: string } | null;
};

function makeFakeDb(config: FakeDbConfig) {
  const ops: DbOp[] = [];

  const insertBuilder = (table: unknown) => ({
    values: async (values: unknown) => {
      ops.push({ kind: "insert", table, values });
    },
  });
  const updateBuilder = (table: unknown) => ({
    set: (set: unknown) => ({
      where: async () => {
        ops.push({ kind: "update", table, set });
      },
    }),
  });
  const deleteBuilder = (table: unknown) => ({
    where: async () => {
      ops.push({ kind: "delete", table });
    },
  });

  const txApi = {
    insert: insertBuilder,
    update: updateBuilder,
    delete: deleteBuilder,
  };

  const db = {
    ops,
    query: {
      tenant: { findFirst: async () => config.tenantRow },
      agent: { findFirst: async () => config.agentRow },
      agentInstance: { findFirst: async () => config.callerInstance },
    },
    insert: insertBuilder,
    update: updateBuilder,
    transaction: async (fn: (tx: typeof txApi) => Promise<void>) => {
      await fn(txApi);
    },
  };
  return db;
}

type SessionServiceFake = {
  launchSession: ReturnType<typeof mock>;
  sendUserMessage: ReturnType<typeof mock>;
};

function makeSessionService(
  overrides: Partial<SessionServiceFake> = {},
): SessionServiceFake {
  return {
    launchSession: mock(async () => {}),
    sendUserMessage: mock(async () => {}),
    ...overrides,
  };
}

const DEPLOYED_AGENT = {
  id: "agent_def_1",
  status: "deployed",
  systemPrompt: "You are a worker",
  capabilities: { tools: ["search", "search", "email", 42] },
};

function makeContext(opts: {
  db: ReturnType<typeof makeFakeDb>;
  sessionService?: SessionServiceFake;
  buildToolDefinitions?: (names: string[]) => unknown[];
  principalId?: string;
}) {
  const eventCollectors = { create: mock(() => {}) };
  return {
    db: opts.db as never,
    tenantId: "tenant_1",
    principalId: opts.principalId ?? "caller_principal",
    agentId: "caller_agent",
    sessionId: "caller_session",
    sessionService: (opts.sessionService ?? makeSessionService()) as never,
    eventCollectors: eventCollectors as never,
    sidecarRouter: {} as never,
    buildToolDefinitions:
      opts.buildToolDefinitions ??
      ((names: string[]) => names.map((n) => ({ name: n }))),
    _eventCollectors: eventCollectors,
  };
}

function getHandler(context: ReturnType<typeof makeContext>) {
  const tools = createDispatchTools(context as never);
  expect(tools).toHaveLength(1);
  const entry = tools[0]!;
  expect(entry.kind).toBe("string");
  expect(entry.definition).toBe(DISPATCH_AGENT_DEFINITION);
  return entry.handler as (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<string>;
}

const VALID_ARGS = { agentDefinitionId: "agent_def_1", task: "do the thing" };

beforeEach(() => {
  idCounter = 0;
  generateKeyPairCalls = 0;
  logCalls.length = 0;
  resolveSourcesImpl = async () => [{ id: "source_a" }, { id: "source_b" }];
  collectGrantsImpl = async () => [{ resource: "tool:search" }];
});

describe("DISPATCH_AGENT_DEFINITION", () => {
  test("declares the dispatch_agent contract", () => {
    expect(DISPATCH_AGENT_DEFINITION.name).toBe("dispatch_agent");
    expect(DISPATCH_AGENT_DEFINITION.inputSchema.required).toEqual([
      "agentDefinitionId",
      "task",
    ]);
    expect(DISPATCH_AGENT_DEFINITION.inputSchema.properties).toHaveProperty(
      "agentDefinitionId",
    );
    expect(DISPATCH_AGENT_DEFINITION.inputSchema.properties).toHaveProperty(
      "task",
    );
  });
});

describe("dispatch_agent handler — argument validation", () => {
  test("rejects when already aborted before starting", async () => {
    const db = makeFakeDb({});
    const handler = getHandler(makeContext({ db }));
    const controller = new AbortController();
    controller.abort();
    await expect(handler(VALID_ARGS, controller.signal)).rejects.toThrow(
      "dispatch_agent aborted before starting",
    );
  });

  test("rejects missing agentDefinitionId", async () => {
    const db = makeFakeDb({});
    const handler = getHandler(makeContext({ db }));
    await expect(
      handler({ task: "x" }, new AbortController().signal),
    ).rejects.toThrow("agentDefinitionId is required");
  });

  test("rejects non-string agentDefinitionId (coerced to empty)", async () => {
    const db = makeFakeDb({});
    const handler = getHandler(makeContext({ db }));
    await expect(
      handler(
        { agentDefinitionId: 123, task: "x" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("agentDefinitionId is required");
  });

  test("rejects missing task", async () => {
    const db = makeFakeDb({});
    const handler = getHandler(makeContext({ db }));
    await expect(
      handler({ agentDefinitionId: "a" }, new AbortController().signal),
    ).rejects.toThrow("task is required");
  });

  test("rejects non-string task (coerced to empty)", async () => {
    const db = makeFakeDb({});
    const handler = getHandler(makeContext({ db }));
    await expect(
      handler(
        { agentDefinitionId: "a", task: { not: "string" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("task is required");
  });
});

describe("dispatch_agent handler — agent-row guards", () => {
  test("rejects when agent definition is not found", async () => {
    const db = makeFakeDb({ agentRow: null });
    const handler = getHandler(makeContext({ db }));
    await expect(
      handler(VALID_ARGS, new AbortController().signal),
    ).rejects.toThrow("Agent definition not found: agent_def_1");
  });

  test("rejects when agent definition is not deployed", async () => {
    const db = makeFakeDb({ agentRow: { ...DEPLOYED_AGENT, status: "draft" } });
    const handler = getHandler(makeContext({ db }));
    await expect(
      handler(VALID_ARGS, new AbortController().signal),
    ).rejects.toThrow("Agent definition is not deployable (status: draft)");
  });

  test("rejects when agent definition has no system prompt", async () => {
    const db = makeFakeDb({
      agentRow: { ...DEPLOYED_AGENT, systemPrompt: null },
    });
    const handler = getHandler(makeContext({ db }));
    await expect(
      handler(VALID_ARGS, new AbortController().signal),
    ).rejects.toThrow("Agent definition has no system prompt");
  });

  test("rejects when aborted after passing agent guards", async () => {
    const db = makeFakeDb({ agentRow: DEPLOYED_AGENT });
    const handler = getHandler(makeContext({ db }));
    // Abort fires during the synchronous stretch after findFirst resolves.
    const controller = new AbortController();
    const original = db.query.agent.findFirst;
    db.query.agent.findFirst = async () => {
      const row = await original();
      controller.abort();
      return row;
    };
    await expect(handler(VALID_ARGS, controller.signal)).rejects.toThrow(
      "dispatch_agent aborted before launch",
    );
  });
});

describe("launchAgentInstance — via handler", () => {
  test("rejects when tenant has no domain", async () => {
    const db = makeFakeDb({ agentRow: DEPLOYED_AGENT, tenantRow: {} });
    const handler = getHandler(makeContext({ db }));
    await expect(
      handler(VALID_ARGS, new AbortController().signal),
    ).rejects.toThrow("Tenant has no domain configured");
  });

  test("rejects when tenant row is missing entirely", async () => {
    const db = makeFakeDb({ agentRow: DEPLOYED_AGENT, tenantRow: null });
    const handler = getHandler(makeContext({ db }));
    await expect(
      handler(VALID_ARGS, new AbortController().signal),
    ).rejects.toThrow("Tenant has no domain configured");
  });

  test("rejects when there are no resolvable inference sources", async () => {
    resolveSourcesImpl = async () => [];
    const db = makeFakeDb({
      agentRow: DEPLOYED_AGENT,
      tenantRow: { domain: "corp.test" },
    });
    const handler = getHandler(makeContext({ db }));
    await expect(
      handler(VALID_ARGS, new AbortController().signal),
    ).rejects.toThrow(
      "No resolvable inference sources for agent credential requirements",
    );
  });

  test("marks session ended and instance error when launch throws, then rethrows", async () => {
    const db = makeFakeDb({
      agentRow: DEPLOYED_AGENT,
      tenantRow: { domain: "corp.test" },
    });
    const sessionService = makeSessionService({
      launchSession: mock(async () => {
        throw new Error("sidecar unavailable");
      }),
    });
    const handler = getHandler(makeContext({ db, sessionService }));
    await expect(
      handler(VALID_ARGS, new AbortController().signal),
    ).rejects.toThrow("sidecar unavailable");

    const updates = db.ops.filter((op) => op.kind === "update") as {
      kind: "update";
      set: { status?: string };
    }[];
    const statuses = updates.map((op) => op.set.status);
    expect(statuses).toContain("ended");
    expect(statuses).toContain("error");
    // The success-only "running" update must not have happened.
    expect(statuses).not.toContain("running");
  });
});

describe("dispatch_agent handler — full success path", () => {
  test("persists, launches, creates collector, sends message, returns running status", async () => {
    const db = makeFakeDb({
      agentRow: DEPLOYED_AGENT,
      tenantRow: { domain: "corp.test" },
      callerInstance: { address: "caller@corp.test" },
    });
    const sessionService = makeSessionService();
    const buildToolDefinitions = mock((names: string[]) =>
      names.map((n) => ({ name: n })),
    );
    const context = makeContext({ db, sessionService, buildToolDefinitions });
    const handler = getHandler(context);

    const result = await handler(VALID_ARGS, new AbortController().signal);
    const parsed = JSON.parse(result) as {
      instanceId: string;
      address: string;
      sessionId: string;
      status: string;
    };

    expect(parsed.status).toBe("running");
    expect(parsed.address).toBe(`${parsed.instanceId}@corp.test`);
    expect(parsed.instanceId).toMatch(/^instance_/);
    expect(parsed.sessionId).toMatch(/^session_/);

    // Tool names from capabilities are string-filtered (non-strings dropped).
    // Dedup happens later inside persistToolGrants, not before this call.
    expect(buildToolDefinitions).toHaveBeenCalledWith([
      "search",
      "search",
      "email",
    ]);

    // launchSession received the resolved sources and defaulted to the first.
    expect(sessionService.launchSession).toHaveBeenCalledTimes(1);
    const launchArg = sessionService.launchSession.mock.calls[0]![0] as {
      config: {
        sources: { id: string }[];
        defaultSource: string;
        tools: unknown[];
      };
      agentAddress: string;
    };
    expect(launchArg.config.defaultSource).toBe("source_a");
    expect(launchArg.config.sources).toHaveLength(2);
    expect(launchArg.agentAddress).toBe(parsed.address);

    // Collector created for the new instance.
    expect(context._eventCollectors.create).toHaveBeenCalledTimes(1);

    // User message sent from the resolved caller address with the task body.
    expect(sessionService.sendUserMessage).toHaveBeenCalledTimes(1);
    const sendArg = sessionService.sendUserMessage.mock.calls[0]![0] as {
      from: string;
      content: string;
      agentAddress: string;
    };
    expect(sendArg.from).toBe("caller@corp.test");
    expect(sendArg.content).toBe("do the thing");
    expect(sendArg.agentAddress).toBe(parsed.address);
    expect(generateKeyPairCalls).toBe(1);

    // Final instance update flips to running.
    const updates = db.ops.filter((op) => op.kind === "update") as {
      set: { status?: string };
    }[];
    expect(updates.some((op) => op.set.status === "running")).toBe(true);

    // Logged the dispatch.
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]!.message).toBe("Agent dispatched");
  });

  test("falls back to dispatcher@system when caller instance is not found", async () => {
    const db = makeFakeDb({
      agentRow: DEPLOYED_AGENT,
      tenantRow: { domain: "corp.test" },
      callerInstance: null,
    });
    const sessionService = makeSessionService();
    const handler = getHandler(makeContext({ db, sessionService }));

    await handler(VALID_ARGS, new AbortController().signal);
    const sendArg = sessionService.sendUserMessage.mock.calls[0]![0] as {
      from: string;
    };
    expect(sendArg.from).toBe("dispatcher@system");
  });

  test("handles agent with null capabilities (no tools)", async () => {
    const db = makeFakeDb({
      agentRow: { ...DEPLOYED_AGENT, capabilities: null },
      tenantRow: { domain: "corp.test" },
      callerInstance: { address: "caller@corp.test" },
    });
    const buildToolDefinitions = mock((names: string[]) =>
      names.map((n) => ({ name: n })),
    );
    const handler = getHandler(makeContext({ db, buildToolDefinitions }));

    const result = await handler(VALID_ARGS, new AbortController().signal);
    expect(JSON.parse(result).status).toBe("running");
    expect(buildToolDefinitions).toHaveBeenCalledWith([]);
  });

  test("rejects when aborted after launch but before send", async () => {
    const db = makeFakeDb({
      agentRow: DEPLOYED_AGENT,
      tenantRow: { domain: "corp.test" },
      callerInstance: { address: "caller@corp.test" },
    });
    const controller = new AbortController();
    const sessionService = makeSessionService({
      launchSession: mock(async () => {
        controller.abort();
      }),
    });
    const handler = getHandler(makeContext({ db, sessionService }));
    await expect(handler(VALID_ARGS, controller.signal)).rejects.toThrow(
      "dispatch_agent aborted before send",
    );
    expect(sessionService.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("DISPATCH_HUB_TOOLS registry entry", () => {
  test("exposes the dispatch_agent definition", () => {
    expect(DISPATCH_HUB_TOOLS.dispatch_agent.definition).toBe(
      DISPATCH_AGENT_DEFINITION,
    );
  });

  test("throws when orchestration context is incomplete", () => {
    const db = makeFakeDb({});
    const partial = {
      db: db as never,
      tenantId: "tenant_1",
      principalId: "p",
      agentId: "a",
      sessionId: "s",
    };
    expect(() =>
      DISPATCH_HUB_TOOLS.dispatch_agent.createTools(partial),
    ).toThrow(
      "dispatch_agent requires full session context (orchestration unavailable)",
    );
  });

  test("builds tools when full orchestration context is present", () => {
    const db = makeFakeDb({});
    const full = makeContext({ db });
    const tools = DISPATCH_HUB_TOOLS.dispatch_agent.createTools(full as never);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.definition).toBe(DISPATCH_AGENT_DEFINITION);
  });
});
