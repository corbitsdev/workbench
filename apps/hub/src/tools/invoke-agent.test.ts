import { describe, expect, it, mock } from "bun:test";
import {
  isInvokeSessionPrompt,
  INVOKE_TEMPLATE_KEY,
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_TRIAGE_NAME,
} from "@workbench/myra";

// Ordered event log shared between the fake db and the launch mock so tests
// can assert ORDERING (attribution insert before launch), not just occurrence.
const events: string[] = [];

// Mock ONLY launchAgentSession at the agent-provisioning seam; every other
// export stays real so transitive importers are unaffected.
const launchCalls: Array<Record<string, unknown>> = [];
const actualProvisioning = await import("../services/agent-provisioning");
mock.module("../services/agent-provisioning", () => ({
  ...actualProvisioning,
  launchAgentSession: async (
    _db: unknown,
    _sessionService: unknown,
    _grantStore: unknown,
    _eventCollectors: unknown,
    opts: Record<string, unknown>,
  ) => {
    launchCalls.push(opts);
    events.push("launch");
    return {
      address: `${opts.instanceId as string}@acme.test`,
      sessionId: "ses_launched",
    };
  },
}));

const { createInvokeAgentTool } = await import("./invoke-agent");
const { INVOKE_AGENT_HUB_TOOLS } = await import("./invoke-agent");

type Row = Record<string, unknown>;

/**
 * Fake hub db: `select()` dequeues canned result sets (the two owner-resolution
 * queries), `query.<table>.findFirst` dequeues per-table canned rows, and
 * `transaction` records inserts into the shared ordered event log. The first
 * transaction can be made to throw (unique-violation conflict path).
 */
function makeDb(opts: {
  selectQueue: Row[][];
  agent?: Array<Row | undefined>;
  tenant?: Array<Row | undefined>;
  memberAgentInstance?: Array<Row | undefined>;
  agentInstance?: Array<Row | undefined>;
  transactionError?: unknown;
}) {
  let selectIndex = 0;
  let transactionError = opts.transactionError;
  const inserted: Array<{ values: Row }> = [];
  const queues: Record<string, Array<Row | undefined>> = {
    agent: opts.agent ?? [],
    tenant: opts.tenant ?? [],
    memberAgentInstance: opts.memberAgentInstance ?? [],
    agentInstance: opts.agentInstance ?? [],
  };
  const finder = (table: string) => ({
    findFirst: () => Promise.resolve(queues[table]?.shift()),
  });
  const db = {
    select: () => {
      const result = opts.selectQueue[selectIndex++] ?? [];
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(result),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(result).then(res, rej),
      };
      return chain;
    },
    query: {
      agent: finder("agent"),
      tenant: finder("tenant"),
      memberAgentInstance: finder("memberAgentInstance"),
      agentInstance: finder("agentInstance"),
    },
    insert: () => ({
      values: (values: Row) => {
        inserted.push({ values });
        events.push(
          values.templateKey === INVOKE_TEMPLATE_KEY
            ? "insert:attribution"
            : "insert:other",
        );
        return Promise.resolve();
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      if (transactionError !== undefined) {
        const err = transactionError;
        transactionError = undefined;
        throw err;
      }
      await fn(db);
    },
  };
  return { db, inserted };
}

const OWNER_RESOLUTION_QUEUE: Row[][] = [
  [{ id: "ins_caller" }],
  [{ memberPrincipalId: "prn_member" }],
];

function makeContext(dbBundle: ReturnType<typeof makeDb>, routable: string[]) {
  const sent: Array<Record<string, unknown>> = [];
  const context = {
    db: dbBundle.db,
    tenantId: "tnt_1",
    principalId: "prn_caller_agent",
    sessionService: {
      sendUserMessage: async (params: Record<string, unknown>) => {
        sent.push(params);
        return new Uint8Array();
      },
    },
    eventCollectors: {},
    sidecarRouter: { getRoutableAddresses: () => routable },
    cryptoProvider: {},
  };
  return { context, sent };
}

function handler(context: unknown) {
  const tool = createInvokeAgentTool(
    context as Parameters<typeof createInvokeAgentTool>[0],
  )[0];
  if (!tool || tool.kind !== "string") throw new Error("expected string tool");
  return (args: Record<string, unknown>) =>
    tool.handler(args, new AbortController().signal);
}

const AGENT_ROW: Row = {
  id: "agt_lincoln",
  name: "Lincoln",
  tenantId: "tnt_1",
  status: "deployed",
  systemPrompt: "You are Lincoln.",
  capabilities: [],
};
const TENANT_ROW: Row = { id: "tnt_1", domain: "acme.test" };

function uniqueViolation(): Error {
  return Object.assign(
    new Error(
      'duplicate key value violates unique constraint "member_agent_instance_invoke_uniq"',
    ),
    { code: "23505" },
  );
}

describe("invoke_agent", () => {
  it("is registered as a write-class hub tool", () => {
    expect(INVOKE_AGENT_HUB_TOOLS.invoke_agent?.sideEffect).toBe("write");
  });

  it("reports the actually-failing argument, not always brief", async () => {
    const bundle = makeDb({ selectQueue: [] });
    const { context } = makeContext(bundle, []);
    await expect(handler(context)({ brief: "do it" })).rejects.toThrow(
      /agentDefinitionId/,
    );
    await expect(
      handler(context)({ agentDefinitionId: "agt_x" }),
    ).rejects.toThrow(/brief/);
  });

  it("fails closed for a caller with no owning member", async () => {
    launchCalls.length = 0;
    const bundle = makeDb({ selectQueue: [[]] });
    const { context } = makeContext(bundle, []);
    await expect(
      handler(context)({ agentDefinitionId: "agt_lincoln", brief: "do it" }),
    ).rejects.toThrow(/member-owned caller/);
    expect(launchCalls.length).toBe(0);
  });

  it("provisions a new instance, writing attribution strictly BEFORE launch, and delivers the brief with the invoke marker", async () => {
    launchCalls.length = 0;
    events.length = 0;
    const bundle = makeDb({
      selectQueue: OWNER_RESOLUTION_QUEUE,
      agent: [AGENT_ROW],
      tenant: [TENANT_ROW],
      memberAgentInstance: [undefined],
      agentInstance: [{ address: "ins_caller@acme.test" }],
    });
    const { context, sent } = makeContext(bundle, []);
    const result = JSON.parse(
      (await handler(context)({
        agentDefinitionId: "agt_lincoln",
        brief: "write a post",
      })) as string,
    );

    // Attribution row written in the provisioning transaction.
    const mappingInsert = bundle.inserted.find(
      (i) => i.values.templateKey === INVOKE_TEMPLATE_KEY,
    );
    expect(mappingInsert?.values.memberPrincipalId).toBe("prn_member");
    expect(mappingInsert?.values.agentId).toBe("agt_lincoln");

    // ORDERING is the grant-wipe defense: the attribution insert must strictly
    // precede the launch, or launchAgentSession's provision-failure cleanup
    // sees an unbound instance and deletes its just-persisted grants.
    const attributionIndex = events.indexOf("insert:attribution");
    const launchIndex = events.indexOf("launch");
    expect(attributionIndex).toBeGreaterThanOrEqual(0);
    expect(launchIndex).toBeGreaterThan(attributionIndex);

    // Launched with the invoke-session marker so the sidecar selects the
    // budget-capped director.
    expect(launchCalls.length).toBe(1);
    expect(isInvokeSessionPrompt(launchCalls[0]!.systemPrompt as string)).toBe(
      true,
    );

    // Brief delivered as mail from the caller's real address.
    expect(sent.length).toBe(1);
    expect(sent[0]!.content).toBe("write a post");
    expect(sent[0]!.from).toBe("ins_caller@acme.test");
    expect(sent[0]!.sessionId).toBe("ses_launched");

    expect(result.status).toBe("invoked");
    expect(result.reused).toBe(false);
  });

  it("on a concurrent-provision unique violation, adopts the winner's instance instead of failing or duplicating", async () => {
    launchCalls.length = 0;
    events.length = 0;
    const bundle = makeDb({
      selectQueue: OWNER_RESOLUTION_QUEUE,
      agent: [AGENT_ROW],
      tenant: [TENANT_ROW],
      // First lookup misses (both racers saw no mapping); after the insert
      // conflicts, the re-read returns the winner's row.
      memberAgentInstance: [undefined, { instanceId: "ins_won" }],
      agentInstance: [
        { id: "ins_won", principalId: "prn_won", address: "ins_won@acme.test" },
        { address: "ins_caller@acme.test" },
      ],
      transactionError: uniqueViolation(),
    });
    const { context, sent } = makeContext(bundle, []);
    const result = JSON.parse(
      (await handler(context)({
        agentDefinitionId: "agt_lincoln",
        brief: "race me",
      })) as string,
    );

    // The loser adopts the winner's instance: no duplicate rows inserted, the
    // launch (dead-instance relaunch) targets the winner's instanceId.
    expect(bundle.inserted.length).toBe(0);
    expect(launchCalls.length).toBe(1);
    expect(launchCalls[0]!.instanceId).toBe("ins_won");
    expect(sent[0]!.content).toBe("race me");
    expect(result.reused).toBe(true);
  });

  it("rethrows a non-conflict transaction failure instead of masking it as a reuse", async () => {
    launchCalls.length = 0;
    const bundle = makeDb({
      selectQueue: OWNER_RESOLUTION_QUEUE,
      agent: [AGENT_ROW],
      tenant: [TENANT_ROW],
      memberAgentInstance: [undefined],
      transactionError: new Error("connection reset"),
    });
    const { context } = makeContext(bundle, []);
    await expect(
      handler(context)({ agentDefinitionId: "agt_lincoln", brief: "x" }),
    ).rejects.toThrow(/connection reset/);
    expect(launchCalls.length).toBe(0);
  });

  it("reuses a routable instance without relaunching (eviction hazard)", async () => {
    launchCalls.length = 0;
    const bundle = makeDb({
      selectQueue: OWNER_RESOLUTION_QUEUE,
      agent: [AGENT_ROW],
      tenant: [TENANT_ROW],
      memberAgentInstance: [{ instanceId: "ins_sub" }],
      agentInstance: [
        {
          id: "ins_sub",
          principalId: "prn_sub",
          address: "ins_sub@acme.test",
        },
        { sessionId: "ses_live" },
        { address: "ins_caller@acme.test" },
      ],
    });
    const { context, sent } = makeContext(bundle, ["ins_sub@acme.test"]);
    const result = JSON.parse(
      (await handler(context)({
        agentDefinitionId: "agt_lincoln",
        brief: "again",
      })) as string,
    );

    expect(launchCalls.length).toBe(0);
    expect(bundle.inserted.length).toBe(0);
    expect(sent[0]!.sessionId).toBe("ses_live");
    expect(result.reused).toBe(true);
  });

  it("relaunches a known but non-routable instance instead of provisioning a duplicate", async () => {
    launchCalls.length = 0;
    const bundle = makeDb({
      selectQueue: OWNER_RESOLUTION_QUEUE,
      agent: [AGENT_ROW],
      tenant: [TENANT_ROW],
      memberAgentInstance: [{ instanceId: "ins_sub" }],
      agentInstance: [
        {
          id: "ins_sub",
          principalId: "prn_sub",
          address: "ins_sub@acme.test",
        },
        { address: "ins_caller@acme.test" },
      ],
    });
    const { context, sent } = makeContext(bundle, []);
    const result = JSON.parse(
      (await handler(context)({
        agentDefinitionId: "agt_lincoln",
        brief: "again",
      })) as string,
    );

    expect(bundle.inserted.length).toBe(0);
    expect(launchCalls.length).toBe(1);
    expect(launchCalls[0]!.instanceId).toBe("ins_sub");
    expect(sent[0]!.sessionId).toBe("ses_launched");
    expect(result.reused).toBe(true);
  });

  it("rejects an unknown agent definition", async () => {
    const bundle = makeDb({
      selectQueue: OWNER_RESOLUTION_QUEUE,
      agent: [undefined],
    });
    const { context } = makeContext(bundle, []);
    await expect(
      handler(context)({ agentDefinitionId: "agt_nope", brief: "x" }),
    ).rejects.toThrow(/not found/);
  });

  it("rejects a non-deployed agent definition", async () => {
    launchCalls.length = 0;
    const bundle = makeDb({
      selectQueue: OWNER_RESOLUTION_QUEUE,
      agent: [{ ...AGENT_ROW, status: "stopped" }],
    });
    const { context } = makeContext(bundle, []);
    await expect(
      handler(context)({ agentDefinitionId: "agt_lincoln", brief: "x" }),
    ).rejects.toThrow(/not deployable/);
    expect(launchCalls.length).toBe(0);
  });

  it("refuses to invoke a personal-agent definition (shared specialists only)", async () => {
    launchCalls.length = 0;
    for (const name of [PERSONAL_AGENT_NAME, PERSONAL_AGENT_TRIAGE_NAME]) {
      const bundle = makeDb({
        selectQueue: OWNER_RESOLUTION_QUEUE,
        agent: [{ ...AGENT_ROW, id: "agt_myra", name }],
      });
      const { context } = makeContext(bundle, []);
      await expect(
        handler(context)({ agentDefinitionId: "agt_myra", brief: "x" }),
      ).rejects.toThrow(/personal agent/);
    }
    expect(launchCalls.length).toBe(0);
  });
});
