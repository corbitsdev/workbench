import { describe, expect, it, mock } from "bun:test";
import type { DB } from "@intx/db";

// Mock the local `./sql-predicates` seam, NOT 'drizzle-orm' directly — see
// list-agents.test.ts for why: mock.module is process-global in Bun, and
// mocking the library would leak into every other suite that introspects
// real drizzle SQL (CL-1825). Only search-agents.ts imports this seam.
mock.module("./sql-predicates", () => ({
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  or: (...conds: unknown[]) => ({ op: "or", conds }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  inArray: (col: unknown, vals: unknown) => ({ op: "inArray", col, vals }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  desc: (col: unknown) => ({ op: "desc", col }),
}));

const {
  createSearchAgentsTool,
  SEARCH_AGENTS_DEFINITION,
  SEARCH_AGENTS_HUB_TOOLS,
} = await import("./search-agents");

type Cond = {
  op: string;
  col?: unknown;
  val?: unknown;
  vals?: unknown;
  conds?: Cond[];
};

function makeDb(resultQueue: unknown[][]) {
  let index = 0;
  const db = {
    select: () => {
      const result = resultQueue[index++] ?? [];
      const chain: Record<string, unknown> = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(result),
        then: (
          resolve: (v: unknown) => unknown,
          reject: (e: unknown) => unknown,
        ) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
  } as unknown as DB["db"];
  return { db };
}

const CONTEXT = { tenantId: "tnt_1", principalId: "prn_caller_agent" };

function handler(db: DB["db"]) {
  const tool = createSearchAgentsTool({ db, ...CONTEXT })[0];
  if (!tool?.handler) throw new Error("expected a handler");
  return (args: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve(
      (tool.handler as (a: Record<string, unknown>) => Promise<unknown>)(args),
    );
}

const OWNERSHIP_ROWS: unknown[][] = [
  [{ id: "ins_caller" }],
  [{ memberPrincipalId: "prn_user" }],
  [{ refId: "usr_1" }],
  [{ id: "prn_user" }],
];

describe("SEARCH_AGENTS_DEFINITION", () => {
  it("requires a query and is registered under search_agents", () => {
    expect(SEARCH_AGENTS_DEFINITION.inputSchema.required).toEqual(["query"]);
    expect(SEARCH_AGENTS_HUB_TOOLS.search_agents?.definition).toBe(
      SEARCH_AGENTS_DEFINITION,
    );
  });
});

describe("search_agents handler", () => {
  it("rejects a missing query", async () => {
    const { db } = makeDb([]);
    await expect(handler(db)({})).rejects.toThrow(/query/);
  });

  it("rejects an empty query", async () => {
    const { db } = makeDb([]);
    await expect(handler(db)({ query: "" })).rejects.toThrow(/query/);
  });

  it("fails closed (empty) for a non-member-owned caller, never tenant-wide", async () => {
    const { db } = makeDb([[]]);
    expect(JSON.parse((await handler(db)({ query: "oat" })) as string)).toEqual(
      { agents: [] },
    );
  });

  it("ranks agents whose name or description matches the query above non-matches", async () => {
    const candidateRows = [
      {
        instanceId: "ins_oat",
        name: "Oat",
        description: "Workspace content agent for GTM collateral",
        address: "ins_oat@acme.interchange",
        status: "running",
        agentDefinitionId: "agt_oat",
      },
      {
        instanceId: "ins_myra",
        name: "Myra",
        description: "Personal assistant",
        address: "ins_myra@acme.interchange",
        status: "running",
        agentDefinitionId: "agt_myra",
      },
    ];
    const { db } = makeDb([
      ...OWNERSHIP_ROWS,
      [{ instanceId: "ins_oat" }, { instanceId: "ins_myra" }],
      candidateRows,
    ]);

    const result = JSON.parse(
      (await handler(db)({ query: "content" })) as string,
    ) as {
      agents: Array<{ instanceId: string }>;
    };

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.instanceId).toBe("ins_oat");
  });

  it("returns no matches when the query hits nothing", async () => {
    const candidateRows = [
      {
        instanceId: "ins_myra",
        name: "Myra",
        description: "Personal assistant",
        address: "ins_myra@acme.interchange",
        status: "running",
        agentDefinitionId: "agt_myra",
      },
    ];
    const { db } = makeDb([
      ...OWNERSHIP_ROWS,
      [{ instanceId: "ins_myra" }],
      candidateRows,
    ]);

    const result = JSON.parse(
      (await handler(db)({ query: "nonexistent-zzz" })) as string,
    ) as { agents: unknown[] };
    expect(result.agents).toEqual([]);
  });

  it("ranks a name match above a description-only match and ties deterministically", async () => {
    const candidateRows = [
      {
        instanceId: "ins_b",
        name: "writer",
        description: "helps with research reports",
        address: "b@x",
        status: "running",
        agentDefinitionId: "agt_b",
      },
      {
        instanceId: "ins_a",
        name: "research scout",
        description: "finds sources",
        address: "a@x",
        status: "running",
        agentDefinitionId: "agt_a",
      },
      {
        instanceId: "ins_c",
        name: "another writer",
        description: "also research reports",
        address: "c@x",
        status: "running",
        agentDefinitionId: "agt_c",
      },
    ];
    const { db } = makeDb([
      ...OWNERSHIP_ROWS,
      [
        { instanceId: "ins_a" },
        { instanceId: "ins_b" },
        { instanceId: "ins_c" },
      ],
      candidateRows,
    ]);
    const output = JSON.parse(
      (await handler(db)({ query: "research" })) as string,
    );
    const ids = output.agents.map((a: { instanceId: string }) => a.instanceId);
    expect(ids).toEqual(["ins_a", "ins_c", "ins_b"]);
  });
});
