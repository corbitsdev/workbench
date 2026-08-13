import { computeCost, totalTokens, type TokenClasses } from "./pricing";
import type { UsageStore, UsageTurnRecord } from "./store";

export type TokenTotals = {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly thinking: number;
  readonly total: number;
};

export type ModelUsageSummary = {
  readonly model: string;
  readonly turns: number;
  readonly tokens: TokenTotals;
  /**
   * USD cost for this model, or null when any class with tokens lacks a
   * rate (or the model has no price row at all and has tokens).
   */
  readonly costUsd: number | null;
};

export type OverallUsageSummary = {
  readonly turns: number;
  readonly tokens: TokenTotals;
  readonly costUsd: number | null;
  readonly byModel: readonly ModelUsageSummary[];
};

export type DayActivity = {
  /** ISO date (YYYY-MM-DD) in UTC. */
  readonly day: string;
  readonly turns: number;
  readonly tokens: number;
};

function emptyTokens(): TokenClasses {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
}

function addTokens(a: TokenClasses, b: TokenClasses): TokenClasses {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    thinking: a.thinking + b.thinking,
  };
}

function toTotals(t: TokenClasses): TokenTotals {
  return { ...t, total: totalTokens(t) };
}

/**
 * Aggregate usage by model and overall for a tenant. Cost is null when
 * any contributing class lacks a rate — never a fabricated zero.
 */
export async function summarizeUsage(
  store: UsageStore,
  tenantId: string,
  opts?: { from?: Date; to?: Date },
): Promise<OverallUsageSummary> {
  const rows = await store.listUsageByTenant(tenantId, opts);
  const byModel = new Map<string, { turns: number; tokens: TokenClasses }>();

  for (const row of rows) {
    const current = byModel.get(row.model) ?? {
      turns: 0,
      tokens: emptyTokens(),
    };
    byModel.set(row.model, {
      turns: current.turns + 1,
      tokens: addTokens(current.tokens, row.tokens),
    });
  }

  const prices = await store.listPrices();
  const priceByModel = new Map(prices.map((p) => [p.model, p.rates]));

  const modelSummaries: ModelUsageSummary[] = [];
  let overallTokens = emptyTokens();
  let overallTurns = 0;
  let overallCost: number | null = 0;

  for (const [model, agg] of [...byModel.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const rates = priceByModel.get(model);
    const cost =
      rates === undefined
        ? totalTokens(agg.tokens) === 0
          ? 0
          : null
        : computeCost(agg.tokens, rates).totalUsd;

    modelSummaries.push({
      model,
      turns: agg.turns,
      tokens: toTotals(agg.tokens),
      costUsd: cost,
    });

    overallTokens = addTokens(overallTokens, agg.tokens);
    overallTurns += agg.turns;
    if (overallCost !== null) {
      if (cost === null) overallCost = null;
      else overallCost += cost;
    }
  }

  return {
    turns: overallTurns,
    tokens: toTotals(overallTokens),
    costUsd: overallCost,
    byModel: modelSummaries,
  };
}

/**
 * Activity histogram by UTC day. Token totals are always known for
 * recorded turns; pre-sink history simply does not appear.
 */
export async function activityByDay(
  store: UsageStore,
  tenantId: string,
  opts?: { from?: Date; to?: Date },
): Promise<readonly DayActivity[]> {
  const rows = await store.listUsageByTenant(tenantId, opts);
  const days = new Map<string, { turns: number; tokens: number }>();

  for (const row of rows) {
    const day = row.recordedAt.toISOString().slice(0, 10);
    const current = days.get(day) ?? { turns: 0, tokens: 0 };
    days.set(day, {
      turns: current.turns + 1,
      tokens: current.tokens + totalTokens(row.tokens),
    });
  }

  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, agg]) => ({ day, turns: agg.turns, tokens: agg.tokens }));
}

/**
 * Run-trace detail is owned by workflow_run / workflow_run_execution in
 * platform schema. This package does not re-query those tables here —
 * the hub mount injects a RunTraceReader when available. Until then
 * callers receive an explicit absent result rather than a fabricated
 * empty trace.
 */
export type RunTraceSpan = {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly durationMs: number | null;
  readonly tokens: TokenClasses | null;
  readonly phase: "ok" | "awaiting" | "failed";
  readonly error: string | null;
};

export type RunTrace = {
  readonly runId: string;
  readonly spans: readonly RunTraceSpan[];
};

export type RunTraceReader = {
  getTrace(tenantId: string, runId: string): Promise<RunTrace | null>;
};

export type ToolCallSummary = {
  readonly tool: string;
  readonly calls: number;
  readonly errors: number;
  readonly errorRate: number | null;
};

/**
 * Calls-by-tool requires turn_part access. When no reader is mounted,
 * return an empty list (no fabricated tools) and document the gap.
 */
export type ToolCallReader = {
  summarize(
    tenantId: string,
    opts?: { from?: Date; to?: Date },
  ): Promise<readonly ToolCallSummary[]>;
};

export function emptyToolCallReader(): ToolCallReader {
  return {
    async summarize() {
      return [];
    },
  };
}

export type { UsageTurnRecord };
