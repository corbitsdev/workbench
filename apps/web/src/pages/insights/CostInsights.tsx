import {
  CategoryBarChart,
  SortableTable,
  TimeSeriesChart,
  type CategoryDatum,
  type SortableColumn,
  type TimeSeries,
} from "@workbench/ui";
import { useQuery } from "@tanstack/react-query";
import { getCacheBaseline, type CacheBaselineRow } from "@workbench/client";
import type { ActivityOverview } from "../../lib/hub-api";
import { clientOptions } from "../../lib/client-options";
import {
  CaveatNote,
  CardLabel,
  HudCard,
  SectionLabel,
  Stat,
  formatNumber,
} from "../InsightsDashboard";

type DateRange = { startDate?: string; endDate?: string };

/**
 * Tenant-wide cost rollup derived from the per-agent cache-baseline rows. Spend
 * is expressed in tokens (the captured telemetry carries no rate card), split
 * into the four billed classes. `promptTokens` is the prompt side that prompt
 * caching bills against (fresh input + cache-read); `cacheAbsorptionRatio` is
 * the fraction of that prefix served from cache — how much of Myra's tool-schema
 * prefix is reused rather than re-billed. Exported for the derivation tests.
 */
export type CostRollup = {
  inferenceCalls: number;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptTokens: number;
  cacheAbsorptionRatio: number;
};

export function aggregateCacheBaseline(rows: CacheBaselineRow[]): CostRollup {
  const totals = rows.reduce(
    (acc, row) => {
      acc.inferenceCalls += row.inferenceCalls;
      acc.sessionCount += row.sessionCount;
      acc.inputTokens += row.inputTokens;
      acc.outputTokens += row.outputTokens;
      acc.cacheReadTokens += row.cacheReadTokens;
      acc.cacheWriteTokens += row.cacheWriteTokens;
      return acc;
    },
    {
      inferenceCalls: 0,
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  );
  const promptTokens = totals.inputTokens + totals.cacheReadTokens;
  return {
    ...totals,
    promptTokens,
    cacheAbsorptionRatio:
      promptTokens === 0 ? 0 : totals.cacheReadTokens / promptTokens,
  };
}

/** The four billed token classes as a semantic split (identity-encoded). */
function tokenSplitBars(rollup: CostRollup): CategoryDatum[] {
  return [
    { label: "Cache read", value: rollup.cacheReadTokens },
    { label: "Fresh input", value: rollup.inputTokens },
    { label: "Output", value: rollup.outputTokens },
    { label: "Cache write", value: rollup.cacheWriteTokens },
  ].filter((row) => row.value > 0);
}

/** Per-day token split from the tenant daily series (over-time cost). */
function tokenSplitSeries(
  dailySeries: ActivityOverview["dailySeries"],
): TimeSeries[] {
  return [
    {
      key: "cacheRead",
      name: "Cache read",
      points: dailySeries.map((d) => ({
        label: d.date,
        value: d.cacheReadTokens,
      })),
    },
    {
      key: "input",
      name: "Fresh input",
      points: dailySeries.map((d) => ({ label: d.date, value: d.inputTokens })),
    },
    {
      key: "output",
      name: "Output",
      points: dailySeries.map((d) => ({
        label: d.date,
        value: d.outputTokens,
      })),
    },
    {
      key: "cacheWrite",
      name: "Cache write",
      points: dailySeries.map((d) => ({
        label: d.date,
        value: d.cacheWriteTokens,
      })),
    },
  ];
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function CostAgentTable({ rows }: { rows: CacheBaselineRow[] }) {
  const columns: SortableColumn<CacheBaselineRow>[] = [
    {
      key: "agent",
      header: "Agent",
      sortValue: (r) => (r.agentName ?? r.agentId).toLowerCase(),
      render: (r) => r.agentName ?? r.agentId,
    },
    {
      key: "inferenceCalls",
      header: "Calls",
      align: "right",
      sortValue: (r) => r.inferenceCalls,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.inferenceCalls)}
        </span>
      ),
    },
    {
      key: "promptTokens",
      header: "Prompt tokens",
      align: "right",
      sortValue: (r) => r.inputTokens + r.cacheReadTokens,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.inputTokens + r.cacheReadTokens)}
        </span>
      ),
    },
    {
      key: "cacheReadTokens",
      header: "Cache read",
      align: "right",
      sortValue: (r) => r.cacheReadTokens,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.cacheReadTokens)}
        </span>
      ),
    },
    {
      key: "cacheWriteTokens",
      header: "Cache write",
      align: "right",
      sortValue: (r) => r.cacheWriteTokens,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.cacheWriteTokens)}
        </span>
      ),
    },
    {
      key: "outputTokens",
      header: "Output",
      align: "right",
      sortValue: (r) => r.outputTokens,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.outputTokens)}
        </span>
      ),
    },
    {
      key: "cacheAbsorptionRatio",
      header: "Prefix cached",
      align: "right",
      sortValue: (r) => r.cacheAbsorptionRatio,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {pct(r.cacheAbsorptionRatio)}
        </span>
      ),
    },
  ];
  return (
    <SortableTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.agentId}
      caption="Token spend by agent"
      initialSort={{ key: "promptTokens", dir: "desc" }}
      pageSize={10}
      emptyMessage="No inference recorded for this range"
    />
  );
}

/**
 * Cost view for the Insights dashboard (CL-2687). Answers "what does an agent
 * cost per day" (the per-day token split, tenant-wide) and "what does each
 * agent cost" (the per-agent rollup + cache split). Owns its own gated,
 * catalog-stale cache-baseline query, independent of the overview query it
 * shares the day series with. The facts carry a sessionId, but no endpoint yet
 * groups them into a per-session token rollup, so per-conversation cost is a
 * fair v1 scope-out — an endpoint gap, not a data limitation — and is omitted
 * rather than stubbed.
 */
export function CostInsights({
  tenantId,
  dailySeries,
  range,
  tokenCaveat,
}: {
  tenantId: string;
  dailySeries: ActivityOverview["dailySeries"];
  range: DateRange;
  tokenCaveat: string | null;
}) {
  const query = useQuery({
    queryKey: [
      "cache-baseline",
      tenantId,
      range.startDate ?? null,
      range.endDate ?? null,
    ],
    queryFn: ({ signal }) =>
      getCacheBaseline(
        { ...clientOptions, init: { signal } },
        {
          tenantId,
          ...(range.startDate !== undefined
            ? { startDate: range.startDate }
            : {}),
          ...(range.endDate !== undefined ? { endDate: range.endDate } : {}),
        },
      ),
    enabled: tenantId !== "",
    staleTime: 5 * 60_000,
  });

  const rows = query.data ?? [];
  const rollup = aggregateCacheBaseline(rows);
  const splitBars = tokenSplitBars(rollup);
  const splitSeries = tokenSplitSeries(dailySeries);
  const hasDaily = dailySeries.length > 0;

  return (
    <div className="flex flex-col gap-4" data-testid="cost-insights">
      <SectionLabel>Cost &amp; token spend</SectionLabel>
      <CaveatNote>
        Spend is measured in tokens — the captured telemetry carries no
        per-model rate card, so no dollar cost is shown.
      </CaveatNote>
      <CaveatNote>
        The split total includes cache-write tokens (a prompt-side billed
        class), so it can exceed the Prompt + Output tokens shown above.
        Thinking and reasoning tokens are excluded from every figure here.
      </CaveatNote>
      <CaveatNote>
        “Prefix cached” is a token share, not a cost saving — cache-read tokens
        bill at a fraction of fresh input but count as equal units here.
        Per-agent totals attribute usage to a named agent, so they may differ
        slightly from the tenant-wide over-time line.
      </CaveatNote>
      {tokenCaveat !== null && <CaveatNote>{tokenCaveat}</CaveatNote>}

      {hasDaily && (
        <HudCard label="Token spend over time · by class">
          <TimeSeriesChart
            series={splitSeries}
            label="Token spend per day, split by billed class"
            variant="line"
            formatValue={formatNumber}
          />
        </HudCard>
      )}

      {query.isLoading && (
        <div
          className="flex flex-col gap-4"
          data-testid="cost-insights-loading"
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-[92px] animate-pulse rounded-[12px] border border-border bg-surface-2"
              />
            ))}
          </div>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <div className="h-[220px] animate-pulse rounded-[12px] border border-border bg-surface-2" />
            <div className="h-[220px] animate-pulse rounded-[12px] border border-border bg-surface-2" />
          </div>
        </div>
      )}

      {query.isError && (
        <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
          Couldn’t load cost data. Try again shortly.
        </div>
      )}

      {query.isSuccess && rows.length === 0 && (
        <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
          No inference cost recorded for this range.
        </div>
      )}

      {query.isSuccess && rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Prompt tokens"
              value={formatNumber(rollup.promptTokens)}
              sub="fresh input + cache read"
              emphasis
            />
            <Stat
              label="Output tokens"
              value={formatNumber(rollup.outputTokens)}
              sub="generated"
              emphasis
            />
            <Stat
              label="Inference calls"
              value={formatNumber(rollup.inferenceCalls)}
              sub={`${formatNumber(rollup.sessionCount)} sessions`}
              emphasis
            />
            <Stat
              label="Prefix cached"
              value={pct(rollup.cacheAbsorptionRatio)}
              sub="tool-prefix reused"
              emphasis
            />
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-2">
            <HudCard
              label="Token split · by class"
              tag={
                <CardLabel>
                  {formatNumber(
                    rollup.promptTokens +
                      rollup.outputTokens +
                      rollup.cacheWriteTokens,
                  )}{" "}
                  total
                </CardLabel>
              }
            >
              <CategoryBarChart
                data={splitBars}
                label="Token spend by billed class"
                colorByCategory
                formatValue={formatNumber}
              />
            </HudCard>
            <HudCard label="Token spend by agent">
              <CostAgentTable rows={rows} />
            </HudCard>
          </div>
        </>
      )}
    </div>
  );
}
