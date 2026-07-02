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
// resolveOwner and, for load, the memory read). Save is an upsert: the artifact
// insert resolves to `upsertResult` (the row the partial-unique index upsert
// returns), and the version-row insert is captured. Captured artifact-insert
// values let a test assert the row is scoped to the resolved owner.
function makeDb(opts: {
  dbSelectQueue: Row[][];
  upsertResult?: { id: string; version: number };
}) {
  const dbSelectQueue = [...opts.dbSelectQueue];
  const insertedArtifacts: Row[] = [];
  const insertedVersions: Row[] = [];

  function selectChain(queue: Row[][]) {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.for = () => chain;
    chain.limit = () => Promise.resolve(queue.shift() ?? []);
    return chain;
  }

  function insertChain(values: Row) {
    // The version-history insert is awaited directly; the artifact upsert chains
    // .onConflictDoUpdate(...).returning() and resolves to the upserted row.
    if ("authorId" in values) {
      insertedVersions.push(values);
      return Promise.resolve();
    }
    insertedArtifacts.push(values);
    const result = opts.upsertResult ?? { id: "art_new", version: 1 };
    return {
      onConflictDoUpdate: () => ({
        returning: () => Promise.resolve([result]),
      }),
    };
  }

  const tx = {
    insert: mock(() => ({ values: mock((v: Row) => insertChain(v)) })),
  };

  const db = {
    select: mock(() => selectChain(dbSelectQueue)),
    transaction: mock((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { db, insertedArtifacts, insertedVersions };
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
  it("writes an owner-scoped memory row and records version 1 on first save", async () => {
    const { db, insertedArtifacts, insertedVersions } = makeDb({
      dbSelectQueue: ownerSelects("mem_owner"),
      upsertResult: { id: "art_mem", version: 1 },
    });
    const { save } = tools(db);

    const result = await save({ content: "first brief" });
    expect(JSON.parse(result as string)).toEqual({ ok: true, version: 1 });

    expect(insertedArtifacts).toHaveLength(1);
    const row = insertedArtifacts[0]!;
    expect(row.kind).toBe("memory");
    expect(row.ownerPrincipalId).toBe("mem_owner");
    expect(row.content).toBe("first brief");
    // The version-history row mirrors the upserted artifact's version.
    expect(insertedVersions[0]?.version).toBe(1);
    expect(insertedVersions[0]?.artifactId).toBe("art_mem");
  });

  it("returns the bumped version the upsert yields on a subsequent save", async () => {
    const { db, insertedVersions } = makeDb({
      dbSelectQueue: ownerSelects("mem_owner"),
      upsertResult: { id: "art_mem", version: 4 },
    });
    const { save } = tools(db);

    const result = await save({ content: "updated brief" });
    expect(JSON.parse(result as string)).toEqual({ ok: true, version: 4 });
    expect(insertedVersions[0]?.version).toBe(4);
    expect(insertedVersions[0]?.content).toBe("updated brief");
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
    const { db, insertedArtifacts } = makeDb({
      dbSelectQueue: ownerSelects("mem_owner"),
    });
    const { save } = tools(db);
    const result = JSON.parse(
      (await save({ content: "x", scope: "chat" })) as string,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not enabled yet");
    expect(insertedArtifacts).toHaveLength(0);
  });
});

describe("memory_load", () => {
  it("returns the owner's stored memory content", async () => {
    const { db } = makeDb({
      dbSelectQueue: [
        ...ownerSelects("mem_owner"),
        [{ id: "art_1", content: "stored brief", version: 2 }],
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
