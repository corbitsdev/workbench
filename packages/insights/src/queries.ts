import type { AuditAuthz } from "@intx/types/audit";

import {
  computeCost,
  totalTokens,
  type TokenClasses,
  type TokenRates,
} from "./pricing";
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

/** One model's tokens/cost within a single day bucket. */
export type ModelDayUsage = {
  readonly model: string;
  readonly tokens: number;
  /** USD cost for this model on this day, or null when its rate is unknown. */
  readonly costUsd: number | null;
};

export type DayActivity = {
  /** ISO date (YYYY-MM-DD) in UTC. */
  readonly day: string;
  readonly turns: number;
  readonly tokens: number;
  /** Same day's tokens/cost split by model — the global landing's
   * tokens/cost-over-time chart stacks on this rather than re-querying. */
  readonly byModel: readonly ModelDayUsage[];
};

/** One workbench's usage totals — the global landing's per-workbench
 * activity chart. */
export type WorkbenchUsage = {
  readonly tenantId: string;
  readonly turns: number;
  readonly tokens: TokenTotals;
  readonly costUsd: number | null;
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

/** Empty-sink usage summary: zero turns/tokens/cost, no model rows. */
export function emptyOverallUsageSummary(): OverallUsageSummary {
  return {
    turns: 0,
    tokens: toTotals(emptyTokens()),
    costUsd: 0,
    byModel: [],
  };
}

function modelCost(
  tokens: TokenClasses,
  rates: TokenRates | undefined,
): number | null {
  if (rates === undefined) return totalTokens(tokens) === 0 ? 0 : null;
  return computeCost(tokens, rates).totalUsd;
}

/** Fold a row set already scoped to the caller's tenant(s) into an overall
 * summary — the shared core `summarizeUsage` and `summarizeUsageByTenant`
 * both reduce to, so per-tenant and cross-tenant totals can never drift
 * apart in how a rate is applied or a null cost is decided. */
function summarizeRows(
  rows: readonly UsageTurnRecord[],
  priceByModel: ReadonlyMap<string, TokenRates>,
): OverallUsageSummary {
  if (rows.length === 0) return emptyOverallUsageSummary();

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

  const modelSummaries: ModelUsageSummary[] = [];
  let overallTokens = emptyTokens();
  let overallTurns = 0;
  let overallCost: number | null = 0;

  for (const [model, agg] of [...byModel.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const cost = modelCost(agg.tokens, priceByModel.get(model));

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

async function loadPriceByModel(
  store: UsageStore,
): Promise<ReadonlyMap<string, TokenRates>> {
  const prices = await store.listPrices();
  return new Map(prices.map((p) => [p.model, p.rates]));
}

/**
 * Aggregate usage by model and overall for a tenant scope. `tenantIds`
 * is one tenant for a single-workbench view, or a workspace parent plus
 * its child workbenches for the cross-workbench rollup — the sum happens
 * here, at the DB-query layer, not by the caller fetching per tenant and
 * adding client-side. Empty sink → zeros (see emptyOverallUsageSummary).
 * Cost is null when any contributing class lacks a rate — never a
 * fabricated cost for unknown rates.
 */
export async function summarizeUsage(
  store: UsageStore,
  tenantIds: readonly string[],
  opts?: { from?: Date; to?: Date },
): Promise<OverallUsageSummary> {
  const rows = await store.listUsageByTenants(tenantIds, opts);
  if (rows.length === 0) return emptyOverallUsageSummary();
  const priceByModel = await loadPriceByModel(store);
  return summarizeRows(rows, priceByModel);
}

/**
 * Same rollup as `summarizeUsage`, but split back out per tenant — the
 * global Insights landing's "activity by workbench" chart, so it can rank
 * and link to individual workbenches instead of only seeing their sum.
 * Every id in `tenantIds` gets an entry, zeroed when that tenant recorded
 * no usage in range, so a quiet workbench still shows up as a zero bar
 * rather than silently disappearing from the ranking.
 */
export async function summarizeUsageByTenant(
  store: UsageStore,
  tenantIds: readonly string[],
  opts?: { from?: Date; to?: Date },
): Promise<readonly WorkbenchUsage[]> {
  const rows = await store.listUsageByTenants(tenantIds, opts);
  const priceByModel = await loadPriceByModel(store);

  const byTenant = new Map<string, UsageTurnRecord[]>();
  for (const row of rows) {
    const bucket = byTenant.get(row.tenantId);
    if (bucket === undefined) byTenant.set(row.tenantId, [row]);
    else bucket.push(row);
  }

  return tenantIds.map((tenantId) => {
    const summary = summarizeRows(byTenant.get(tenantId) ?? [], priceByModel);
    return {
      tenantId,
      turns: summary.turns,
      tokens: summary.tokens,
      costUsd: summary.costUsd,
    };
  });
}

/**
 * Activity histogram by UTC day across a tenant scope (see summarizeUsage
 * for what `tenantIds` means). Token totals are always known for recorded
 * turns; pre-sink history simply does not appear.
 */
export async function activityByDay(
  store: UsageStore,
  tenantIds: readonly string[],
  opts?: { from?: Date; to?: Date },
): Promise<readonly DayActivity[]> {
  const rows = await store.listUsageByTenants(tenantIds, opts);
  const priceByModel = await loadPriceByModel(store);
  const days = new Map<
    string,
    { turns: number; tokens: number; byModel: Map<string, TokenClasses> }
  >();

  for (const row of rows) {
    const day = row.recordedAt.toISOString().slice(0, 10);
    const current = days.get(day) ?? {
      turns: 0,
      tokens: 0,
      byModel: new Map<string, TokenClasses>(),
    };
    current.turns += 1;
    current.tokens += totalTokens(row.tokens);
    current.byModel.set(
      row.model,
      addTokens(current.byModel.get(row.model) ?? emptyTokens(), row.tokens),
    );
    days.set(day, current);
  }

  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, agg]) => ({
      day,
      turns: agg.turns,
      tokens: agg.tokens,
      byModel: [...agg.byModel.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([model, tokens]) => ({
          model,
          tokens: totalTokens(tokens),
          costUsd: modelCost(tokens, priceByModel.get(model)),
        })),
    }));
}

/**
 * Run-trace detail is owned by workflow_run / inference_turn / turn_part
 * in the platform schema (see @corbits/insights' createDrizzleRunTraceReader
 * for the concrete reader). This package's route layer does not re-query
 * those tables itself — the hub mount injects a RunTraceReader. A tenant
 * that mounts none receives an explicit absent result rather than a
 * fabricated empty trace.
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
  /**
   * Authorization verdict for a `kind: "tool"` span. Verdicts are recorded
   * only in the sidecar-side git-backed audit trail (`AuditRecord`, written
   * via `IsogitStore.commitAudit`), which the hub's Postgres-only
   * composition root has no read path into today — so this is always
   * `null` for now, an honest absence rather than a fabricated verdict.
   * The field exists so CL-5927 (Settings · Audit) can consume tool-call
   * rows from this same reader once that read path is wired.
   * Only ever populated for `kind: "tool"` spans (other kinds never carry
   * a verdict); `undefined` and `null` are not interchangeable here —
   * optional (`authz?:`) only because most call sites never set it, while
   * the reader always sets `null` explicitly for tool spans as an honest
   * "not reachable yet" rather than an unset "no opinion on whether this
   * exists".
   */
  readonly authz?: AuditAuthz | null;
  /**
   * How this span's start/end were derived. "measured" means real
   * wall-clock timestamps (inference_turn.startedAt/endedAt); "ordinal"
   * means the span was positioned by turn_part.ordinal within its
   * enclosing turn's window, not a real timestamp (see `positionInTurn`
   * in trace-reader.ts) — an honest sequence marker, not a duration
   * measurement.
   */
  readonly timingSource: "measured" | "ordinal";
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
 * `tenantIds` carries the same single-tenant-or-scope contract as
 * summarizeUsage/activityByDay — a real reader owns merging across the
 * scope itself, at its own query layer.
 */
export type ToolCallReader = {
  summarize(
    tenantIds: readonly string[],
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
