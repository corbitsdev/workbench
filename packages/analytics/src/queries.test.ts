import { describe, expect, it, mock } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import {
  getAnalyticsModelDistribution,
  getCacheBaseline,
  getTenantToolBreakdown,
  getTokenDataStartDate,
} from "./queries";

function makeDb(rows: { date: string | null }[]) {
  const captured: { where?: SQL } = {};
  const where = mock(async (predicate: SQL) => {
    captured.where = predicate;
    return rows;
  });
  const from = mock(() => ({ where }));
  const select = mock(() => ({ from }));
  return { db: { select } as never, captured };
}

function renderWhere(predicate: SQL | undefined): string {
  if (predicate === undefined) throw new Error("no where predicate captured");
  return new PgDialect().sqlToQuery(predicate).sql;
}

function makeModelDb(
  rows: {
    model: string | null;
    turnCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    thinkingTokens?: number;
  }[],
) {
  const captured: { where?: SQL } = {};
  const groupBy = mock(async () => rows);
  const where = mock((predicate: SQL) => {
    captured.where = predicate;
    return { groupBy };
  });
  const from = mock(() => ({ where }));
  const select = mock(() => ({ from }));
  return { db: { select } as never, captured };
}

describe("getTokenDataStartDate", () => {
  it("returns the earliest bucket date that carries real tokens", async () => {
    const { db } = makeDb([{ date: "2026-06-10" }]);
    expect(await getTokenDataStartDate({ db, tenantId: "tnt_1" })).toBe(
      "2026-06-10",
    );
  });

  it("returns null when the tenant has no token-bearing buckets (min is null)", async () => {
    const { db } = makeDb([{ date: null }]);
    expect(await getTokenDataStartDate({ db, tenantId: "tnt_1" })).toBeNull();
  });

  it("returns null when there are no rows at all", async () => {
    const { db } = makeDb([]);
    expect(await getTokenDataStartDate({ db, tenantId: "tnt_1" })).toBeNull();
  });

  it("filters on the tenant and a positive sum over every token column", async () => {
    const { db, captured } = makeDb([{ date: "2026-06-10" }]);
    await getTokenDataStartDate({ db, tenantId: "tnt_1" });

    const sql = renderWhere(captured.where);
    expect(sql).toContain('"tenant_id"');
    for (const col of [
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "thinking_tokens",
    ]) {
      expect(sql).toContain(`"${col}"`);
    }
    expect(sql).toContain("> 0");
  });
});

function makeCacheBaselineDb(
  rows: {
    agentId: string | null;
    agentName: string | null;
    inferenceCalls: number;
    cacheMissCalls: number;
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }[],
) {
  const captured: { where?: SQL } = {};
  const groupBy = mock(async () => rows);
  const where = mock((predicate: SQL) => {
    captured.where = predicate;
    return { groupBy };
  });
  const leftJoin = mock(() => ({ where }));
  const from = mock(() => ({ leftJoin }));
  const select = mock(() => ({ from }));
  return { db: { select } as never, captured };
}

describe("getCacheBaseline", () => {
  it("derives cache-miss rate and prefix-absorption ratio per agent", async () => {
    const { db } = makeCacheBaselineDb([
      {
        agentId: "agt_myra",
        agentName: "Myra",
        inferenceCalls: 10,
        cacheMissCalls: 2,
        sessionCount: 4,
        inputTokens: 2000,
        outputTokens: 500,
        cacheReadTokens: 8000,
        cacheWriteTokens: 1200,
      },
    ]);

    const rows = await getCacheBaseline({ db, tenantId: "tnt_1" });

    expect(rows).toEqual([
      {
        agentId: "agt_myra",
        agentName: "Myra",
        inferenceCalls: 10,
        cacheMissCalls: 2,
        cacheHitCalls: 8,
        sessionCount: 4,
        inputTokens: 2000,
        outputTokens: 500,
        cacheReadTokens: 8000,
        cacheWriteTokens: 1200,
        cacheMissRate: 0.2,
        cacheAbsorptionRatio: 0.8,
      },
    ]);
  });

  it("omits agents with no completed inference calls and null agentId", async () => {
    const { db } = makeCacheBaselineDb([
      {
        agentId: "agt_idle",
        agentName: "Idle",
        inferenceCalls: 0,
        cacheMissCalls: 0,
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        agentId: null,
        agentName: null,
        inferenceCalls: 3,
        cacheMissCalls: 0,
        sessionCount: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 90,
        cacheWriteTokens: 0,
      },
    ]);

    expect(await getCacheBaseline({ db, tenantId: "tnt_1" })).toEqual([]);
  });

  it("reports a zero absorption ratio when no prompt tokens were seen", async () => {
    const { db } = makeCacheBaselineDb([
      {
        agentId: "agt_myra",
        agentName: "Myra",
        inferenceCalls: 1,
        cacheMissCalls: 1,
        sessionCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);

    const rows = await getCacheBaseline({ db, tenantId: "tnt_1" });
    expect(rows[0]?.cacheAbsorptionRatio).toBe(0);
    expect(rows[0]?.cacheMissRate).toBe(1);
  });

  it("filters on tenant and only completed inference calls", async () => {
    const { db, captured } = makeCacheBaselineDb([]);
    await getCacheBaseline({ db, tenantId: "tnt_1", agentId: "agt_myra" });

    const sql = renderWhere(captured.where);
    expect(sql).toContain('"tenant_id"');
    expect(sql).toContain('"event_type"');
    expect(sql).toContain('"agent_id"');
  });
});

describe("getAnalyticsModelDistribution", () => {
  it("omits grouped model totals with zero turns after aggregation", async () => {
    const { db } = makeModelDb([
      { model: "deepseek", turnCount: 3, inputTokens: 125, outputTokens: 50 },
      { model: "zero-turn", turnCount: 0, inputTokens: 40, outputTokens: 20 },
      { model: null, turnCount: 5, inputTokens: 500, outputTokens: 250 },
    ]);

    const rows = await getAnalyticsModelDistribution({ db, tenantId: "tnt_1" });

    expect(rows.map((r) => r.model)).toEqual(["deepseek"]);
  });

  it("carries every token class separately for per-model cost (CL-2714)", async () => {
    const { db } = makeModelDb([
      {
        model: "claude-opus-4-5",
        turnCount: 2,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 500,
        cacheWriteTokens: 30,
        thinkingTokens: 12,
      },
    ]);

    const rows = await getAnalyticsModelDistribution({ db, tenantId: "tnt_1" });

    expect(rows[0]).toEqual({
      model: "claude-opus-4-5",
      turnCount: 2,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 500,
      cacheWriteTokens: 30,
      thinkingTokens: 12,
    });
  });
});

function makeExecuteDb(rows: Record<string, unknown>[]) {
  const captured: { query?: SQL } = {};
  const execute = mock(async (query: SQL) => {
    captured.query = query;
    return rows;
  });
  return { db: { execute } as never, captured };
}

describe("getTenantToolBreakdown", () => {
  it("maps executed rows to tool/call/error triples", async () => {
    const { db } = makeExecuteDb([
      { name: "web_search", calls: 12, errors: 2 },
      { name: "gamma_generate", calls: 5, errors: 0 },
    ]);

    const rows = await getTenantToolBreakdown({ db, tenantId: "tnt_1" });

    expect(rows).toEqual([
      { name: "web_search", calls: 12, errors: 2 },
      { name: "gamma_generate", calls: 5, errors: 0 },
    ]);
  });

  it("coerces missing/blank names to 'Unknown tool' and numeric fields to numbers", async () => {
    const { db } = makeExecuteDb([{ name: "  ", calls: "3", errors: null }]);

    const rows = await getTenantToolBreakdown({ db, tenantId: "tnt_1" });

    expect(rows[0]).toEqual({ name: "Unknown tool", calls: 3, errors: 0 });
  });

  it("scopes to the tenant and every tool_call, WITHOUT any principal filter", async () => {
    const { db, captured } = makeExecuteDb([]);

    await getTenantToolBreakdown({ db, tenantId: "tnt_1" });

    const rendered = new PgDialect().sqlToQuery(captured.query as SQL).sql;
    expect(rendered).toContain("tenant_id");
    expect(rendered).toContain("tool_call");
    // The tenant breakdown is deliberately NOT scoped to any principal set —
    // that is the whole point of the tenant-wide companion query (CL-3667).
    expect(rendered).not.toContain("principal_id");
  });
});
