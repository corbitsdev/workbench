import {
  SortableTable,
  TimeSeriesChart,
  type SortableColumn,
  type TimeSeries,
} from "@workbench/ui";
import {
  computeCost,
  priceUsageRows,
  resolveModelRate,
  type ModelRate,
  type PriceCatalog,
  type TokenCost,
} from "@workbench/pricing";
import type { ActivityOverview, UsageByPersonRow } from "../../lib/hub-api";
import { useModelPricing } from "../../hooks/use-model-pricing";
import { ProviderLogoMark } from "./ProviderLogoMark";
import { CaveatNote, HudCard, Stat, formatNumber } from "../InsightsDashboard";
import { SectionLabel } from "./section-label";

type DateRange = { startDate?: string; endDate?: string };

/** Per-day token-class series over the tenant daily rollup (fresh input, cache read, cache write, output — always separate). */
function tokenClassSeries(
  dailySeries: ActivityOverview["dailySeries"],
): TimeSeries[] {
  return [
    {
      key: "input",
      name: "Input",
      points: dailySeries.map((d) => ({ label: d.date, value: d.inputTokens })),
    },
    {
      key: "cacheRead",
      name: "Cache read",
      points: dailySeries.map((d) => ({
        label: d.date,
        value: d.cacheReadTokens,
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
    {
      key: "output",
      name: "Output",
      points: dailySeries.map((d) => ({
        label: d.date,
        value: d.outputTokens,
      })),
    },
  ];
}

function formatDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

function totalTokensFor(row: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return (
    row.inputTokens +
    row.outputTokens +
    row.cacheReadTokens +
    row.cacheWriteTokens
  );
}

type ModelCostRow = ActivityOverview["byModel"][number] & {
  rate: ModelRate | null;
  cost: TokenCost | null;
};

function CostByModelTable({
  tenantId,
  rows,
}: {
  tenantId: string;
  rows: ModelCostRow[];
}) {
  const columns: SortableColumn<ModelCostRow>[] = [
    {
      key: "model",
      header: "Model",
      sortValue: (r) => r.model.toLowerCase(),
      render: (r) => (
        <span className="flex items-center gap-2">
          {r.rate && (
            <ProviderLogoMark
              tenantId={tenantId}
              provider={r.rate.provider}
              providerName={r.rate.providerName}
            />
          )}
          <span>{r.model}</span>
        </span>
      ),
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sortValue: (r) => r.cost?.total ?? -1,
      render: (r) =>
        r.cost === null ? (
          <span
            title="No pricing rate for this model in the models.dev catalog"
            className="rounded-[4px] bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-3"
          >
            no rate
          </span>
        ) : (
          <span className="font-mono tabular-nums text-text">
            {formatDollars(r.cost.total)}
          </span>
        ),
    },
    {
      key: "inputTokens",
      header: "Input",
      align: "right",
      sortValue: (r) => r.inputTokens,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.inputTokens)}
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
  ];
  return (
    <SortableTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.model}
      caption="Cost by model"
      initialSort={{ key: "cost", dir: "desc" }}
      pageSize={10}
      emptyMessage="No model usage for this range"
    />
  );
}

function CostByActorTable({ people }: { people: UsageByPersonRow[] }) {
  const columns: SortableColumn<UsageByPersonRow>[] = [
    {
      key: "name",
      header: "Person",
      sortValue: (r) => (r.name ?? "Unknown member").toLowerCase(),
      render: (r) => (
        <span>
          {r.name ?? "Unknown member"}
          {r.isSelf && (
            <span className="ml-1.5 text-[11px] font-semibold text-accent">
              (me)
            </span>
          )}
        </span>
      ),
    },
    {
      key: "inputTokens",
      header: "Input",
      align: "right",
      sortValue: (r) => r.inputTokens,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.inputTokens)}
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
  ];
  return (
    <SortableTable
      columns={columns}
      rows={people}
      getRowKey={(r) => r.principalId}
      caption="Token spend by actor"
      initialSort={{ key: "inputTokens", dir: "desc" }}
      pageSize={10}
      emptyMessage="No attributed usage for this range"
    />
  );
}

/**
 * Cost view for the Insights dashboard (CL-2714). Dollar figures come from the
 * hub-cached models.dev rate catalog; token classes (input, cache read, cache
 * write, output) are always shown as distinct series/columns — never summed
 * into an ambiguous "prompt tokens" figure. Every dollar shown is derived from
 * a resolved rate; usage with no matching rate is flagged, never priced at a
 * fabricated figure.
 */
export function CostInsights({
  tenantId,
  overview,
  tokenCaveat,
}: {
  tenantId: string;
  overview: ActivityOverview;
  range: DateRange;
  tokenCaveat: string | null;
}) {
  const pricingQuery = useModelPricing(tenantId);
  const catalog: PriceCatalog | null = pricingQuery.data ?? null;
  const pricingUnavailable =
    pricingQuery.isError ||
    (pricingQuery.isSuccess && Object.keys(catalog?.models ?? {}).length === 0);

  const hasDaily = overview.dailySeries.length > 0;
  const classSeries = tokenClassSeries(overview.dailySeries);
  const totalTokens = overview.byModel.reduce(
    (sum, row) => sum + totalTokensFor(row),
    0,
  );

  const priced =
    catalog !== null ? priceUsageRows(overview.byModel, catalog) : null;

  const modelRows: ModelCostRow[] = overview.byModel.map((row) => {
    const rate = catalog !== null ? resolveModelRate(catalog, row.model) : null;
    return { ...row, rate, cost: computeCost(row, rate) };
  });

  return (
    <div className="flex flex-col gap-4" data-testid="cost-insights">
      <SectionLabel>Cost</SectionLabel>
      <CaveatNote>
        Token classes are always shown separately — fresh input, cache read,
        cache write, output are never summed into one figure.
      </CaveatNote>
      {tokenCaveat !== null && <CaveatNote>{tokenCaveat}</CaveatNote>}

      {pricingQuery.isLoading && (
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
          data-testid="cost-insights-pricing-loading"
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[92px] animate-pulse rounded-[12px] border border-border bg-surface-2"
            />
          ))}
        </div>
      )}

      {!pricingQuery.isLoading && pricingUnavailable && (
        <CaveatNote>
          Model pricing unavailable — showing tokens only, no dollar figures.
        </CaveatNote>
      )}

      {!pricingQuery.isLoading && priced && !pricingUnavailable && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
          <Stat
            label="Total cost"
            value={formatDollars(priced.cost.total)}
            sub={`${formatNumber(totalTokens)} tokens`}
            emphasis
          />
          {priced.hasUnpriced ? (
            <Stat
              label="Unpriced models"
              value={`${priced.unpricedModels.length}`}
              sub="shown as tokens only — no models.dev rate"
              emphasis
            />
          ) : (
            <Stat
              label="Models priced"
              value={`${overview.byModel.length}`}
              sub="all resolved a rate"
              emphasis
            />
          )}
        </div>
      )}

      {hasDaily && (
        <HudCard label="Token usage over time · by class">
          <TimeSeriesChart
            series={classSeries}
            label="Token usage per day, by class"
            variant="line"
            formatValue={formatNumber}
          />
        </HudCard>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <HudCard label="Cost by model">
          <CostByModelTable tenantId={tenantId} rows={modelRows} />
        </HudCard>
        <HudCard label="Token spend by actor">
          <CaveatNote>
            Dollar cost is attributed at the model level, not per actor — usage
            rows here carry no per-actor model breakdown, so a per-person dollar
            figure would be fabricated.
          </CaveatNote>
          <CostByActorTable people={overview.byPerson} />
        </HudCard>
      </div>
    </div>
  );
}
