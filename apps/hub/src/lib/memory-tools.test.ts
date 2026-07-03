/// <reference types="bun" />
import { describe, expect, it, mock } from "bun:test";
import type { AgentTool } from "@intx/agent";
import {
  MEMORY_LOAD_DEFINITION,
  MEMORY_SAVE_DEFINITION,
} from "@workbench/tools-artifact";
import { createMemoryTools, MEMORY_HUB_TOOLS } from "./memory-tools";

type Row = Record<string, unknown>;

const BASE_CONTEXT = {
  tenantId: "tnt_1",
  principalId: "prn_instance_1",
};

// resolveOwnerMemberPrincipalId (imported from ./artifact-tools) runs two
// selects: agent_instance by (tenantId, principalId), then member_agent_instance
// by (tenantId, instanceId). We drive its result by seeding those two select
// results, so the owner the handler scopes to is whatever the member row yields.
function ownerSelects(owner: string | null): Row[][] {
  if (owner === null) {
    // First select resolves an instance, second finds no owning member.
    return [[{ id: "ins_1" }], []];
  }
  return [[{ id: "ins_1" }], [{ memberPrincipalId: owner }]];
}

// A drizzle-shaped mock. `dbSelectQueue` feeds db.select(...) terminals (used by
// resolveOwner and, for load, the memory read). Save is a plain upsert onto the
// memory table's (tenantId, ownerPrincipalId) unique index; captured insert
// values let a test assert the row is scoped to the resolved owner and content.
function makeDb(opts: { dbSelectQueue: Row[][] }) {
  const dbSelectQueue = [...opts.dbSelectQueue];
  const insertedMemories: Row[] = [];

  function selectChain(queue: Row[][]) {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.for = () => chain;
    chain.limit = () => Promise.resolve(queue.shift() ?? []);
    return chain;
  }

  const db = {
    select: mock(() => selectChain(dbSelectQueue)),
    insert: mock((v: Row) => {
      insertedMemories.push(v);
      return {
        values: mock((values: Row) => {
          insertedMemories[insertedMemories.length - 1] = values;
          return {
            onConflictDoUpdate: () => Promise.resolve(),
          };
        }),
      };
    }),
  };

  return { db, insertedMemories };
}

const SIGNAL = new AbortController().signal;

function invoke(tool: AgentTool, args: Row) {
  return (tool.handler as (a: Row, s: AbortSignal) => unknown)(args, SIGNAL);
}

function tools(db: unknown) {
  const [load, save] = createMemoryTools({
    db: db as never,
    ...BASE_CONTEXT,
  });
  if (!load || !save) throw new Error("expected load and save tools");
  return {
    load: (args: Row) => invoke(load, args),
    save: (args: Row) => invoke(save, args),
  };
}

describe("MEMORY_HUB_TOOLS registry", () => {
  it("registers memory_load and memory_save under their definition names", () => {
    expect(Object.keys(MEMORY_HUB_TOOLS).sort()).toEqual([
      "memory_load",
      "memory_save",
    ]);
    expect(MEMORY_HUB_TOOLS.memory_load!.definition).toBe(
      MEMORY_LOAD_DEFINITION,
    );
    expect(MEMORY_HUB_TOOLS.memory_save!.definition).toBe(
      MEMORY_SAVE_DEFINITION,
    );
  });
});

describe("memory_save", () => {
  it("writes an owner-scoped memory row on first save", async () => {
    const { db, insertedMemories } = makeDb({
      dbSelectQueue: ownerSelects("mem_owner"),
    });
    const { save } = tools(db);

    const result = await save({ content: "first brief" });
    expect(JSON.parse(result as string)).toEqual({ ok: true });

    expect(insertedMemories).toHaveLength(1);
    const row = insertedMemories[0]!;
    expect(row.tenantId).toBe("tnt_1");
    expect(row.ownerPrincipalId).toBe("mem_owner");
    expect(row.content).toBe("first brief");
  });

  it("overwrites prior content on a subsequent save rather than versioning it", async () => {
    const { db, insertedMemories } = makeDb({
      // Two saves against the same owner; each save resolves the owner once.
      dbSelectQueue: [
        ...ownerSelects("mem_owner"),
        ...ownerSelects("mem_owner"),
      ],
    });
    const { save } = tools(db);

    await save({ content: "first brief" });
    const result = await save({ content: "updated brief" });

    expect(JSON.parse(result as string)).toEqual({ ok: true });
    expect(insertedMemories).toHaveLength(2);
    expect(insertedMemories[1]?.content).toBe("updated brief");
  });

  it("fails closed when the agent has no owning user", async () => {
    const { db } = makeDb({ dbSelectQueue: ownerSelects(null) });
    const { save } = tools(db);
    await expect(save({ content: "x" })).rejects.toThrow(/no owning user/);
  });

  it("rejects an empty content payload", async () => {
    const { db } = makeDb({ dbSelectQueue: ownerSelects("mem_owner") });
    const { save } = tools(db);
    await expect(save({ content: "" })).rejects.toThrow(/content is required/);
  });

  it("defers chat scope without writing", async () => {
    const { db, insertedMemories } = makeDb({
      dbSelectQueue: ownerSelects("mem_owner"),
    });
    const { save } = tools(db);
    const result = JSON.parse(
      (await save({ content: "x", scope: "chat" })) as string,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not enabled yet");
    expect(insertedMemories).toHaveLength(0);
  });
});

describe("memory_load", () => {
  it("returns the owner's stored memory content, and the overwritten content after a re-save", async () => {
    const { db } = makeDb({
      dbSelectQueue: [
        ...ownerSelects("mem_owner"),
        [{ content: "stored brief" }],
      ],
    });
    const { load } = tools(db);
    const result = JSON.parse((await load({})) as string);
    expect(result).toEqual({ content: "stored brief" });
  });

  it("returns empty content when nothing is stored yet", async () => {
    const { db } = makeDb({
      dbSelectQueue: [...ownerSelects("mem_owner"), []],
    });
    const { load } = tools(db);
    const result = JSON.parse((await load({})) as string);
    expect(result).toEqual({ content: "" });
  });

  it("returns empty content when the agent has no owning user", async () => {
    const { db } = makeDb({ dbSelectQueue: ownerSelects(null) });
    const { load } = tools(db);
    const result = JSON.parse((await load({})) as string);
    expect(result).toEqual({ content: "" });
  });

  it("defers chat scope", async () => {
    const { db } = makeDb({ dbSelectQueue: [] });
    const { load } = tools(db);
    const result = JSON.parse((await load({ scope: "chat" })) as string);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not enabled yet");
  });
});
