import {
  CategoryBarChart,
  PagePanel,
  SortableTable,
  TimeSeriesChart,
  type CategoryDatum,
  type SortableColumn,
  type TimeSeries,
} from "@workbench/ui";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { Link } from "react-router";
import { AlertTriangle, BarChart2 } from "lucide-react";
import { priceUsageRows } from "@workbench/pricing";
import { actorHref } from "./insights/ActorActivity";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { useModelPricing } from "../hooks/use-model-pricing";
import { describeHubApiFailure, getActivityOverview } from "../lib/hub-api";
import type {
  ActivityOverview,
  AnalyticsSummary,
  UsageByPersonRow,
  UsageByWorkflowTypeRow,
} from "../lib/hub-api";
import {
  DeltaBadge,
  Heatmap,
  MiniBars,
  Sparkline,
  TokenMosaic,
} from "./insights/viz";
import { ActorActivitySection } from "./insights/ActorActivity";
import { CostInsights } from "./insights/CostInsights";
import { RecentActivity } from "./insights/RecentActivity";
import {
  cacheHitRate,
  computeDelta,
  fillDailySeries,
  humanizeKey,
  ratePct,
  tokenDataCaveat,
} from "./insights/metrics";

type Preset = "24h" | "7d" | "30d" | "90d" | "all" | "custom";

const PRESETS: { label: string; value: Preset }[] = [
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
  { label: "All time", value: "all" },
  { label: "Custom", value: "custom" },
];

type DateRange = { startDate?: string; endDate?: string };

/** Actor-kind filter for the person-scoped views. */
type ActorFilter = "all" | "me" | "others";

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// Analytics are bucketed by calendar day, so "24 hours" resolves to a
// startDate one day back — today plus yesterday inclusive, matching the other
// presets' N-days-ago convention and avoiding an empty view just after
// midnight.
const PRESET_DAYS: Record<Exclude<Preset, "all" | "custom">, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/**
 * Resolves the selected preset (plus the custom-range inputs when the "custom"
 * preset is active) to the `{ startDate, endDate }` the overview query is keyed
 * on. A custom range only takes effect once a start date is entered; an empty
 * custom start falls back to an all-time range so the page never queries a
 * nonsensical window. Exported for the query-range tests.
 */
export function resolveRange(preset: Preset, custom: DateRange): DateRange {
  if (preset === "all") return {};
  if (preset === "custom") {
    if (custom.startDate === undefined || custom.startDate === "") return {};
    return {
      startDate: custom.startDate,
      ...(custom.endDate ? { endDate: custom.endDate } : {}),
    };
  }
  return { startDate: daysAgoISO(PRESET_DAYS[preset]) };
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

function totalTokens(s: AnalyticsSummary): number {
  return (
    s.inputTokens +
    s.outputTokens +
    s.cacheReadTokens +
    s.cacheWriteTokens +
    s.thinkingTokens
  );
}

// Uppercase + tracking is the brand "Caption" style (Red Hat Display, not mono).
// Space Mono is reserved for true data readouts — numbers, IDs, timestamps.
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
      {children}
    </h2>
  );
}

export function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">
      {children}
    </span>
  );
}

export function CaveatNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="flex items-start gap-1.5 text-[11px] leading-snug text-text-3"
      data-testid="data-caveat"
    >
      <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-text-3" />
      <span>{children}</span>
    </p>
  );
}

export function HudCard({
  label,
  tag,
  children,
  className = "",
}: {
  label?: string;
  tag?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-[12px] border border-border bg-surface p-4 ${className}`}
    >
      {(label || tag) && (
        <div className="flex items-center justify-between">
          {label ? <CardLabel>{label}</CardLabel> : <span />}
          {tag}
        </div>
      )}
      {children}
    </div>
  );
}

function statValueClass(accent?: boolean, danger?: boolean): string {
  if (danger) return "text-red";
  if (accent) return "text-accent";
  return "text-text";
}

export function Stat({
  label,
  value,
  sub,
  delta,
  accent,
  danger,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: ReturnType<typeof computeDelta>;
  /** Orange action tone — reserve for genuine action/positive emphasis. */
  accent?: boolean;
  /** Semantic danger (red) — for failure counts, never the action accent. */
  danger?: boolean;
  /** Headline tile: larger value + padding so the KPI row anchors the page. */
  emphasis?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-[12px] border border-border bg-surface ${emphasis ? "p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]" : "p-4"}`}
    >
      <CardLabel>{label}</CardLabel>
      <div className="flex items-baseline gap-2">
        <span
          className={`font-black leading-none tabular-nums ${emphasis ? "text-[34px]" : "text-[26px]"} ${statValueClass(accent, danger)}`}
        >
          {value}
        </span>
        {delta && <DeltaBadge delta={delta} />}
      </div>
      {sub && (
        <span className="text-[10px] uppercase tracking-[0.08em] text-text-3">
          {sub}
        </span>
      )}
    </div>
  );
}

function TrendCard({
  label,
  total,
  values,
  delta,
  note,
}: {
  label: string;
  total: string;
  values: number[];
  delta?: ReturnType<typeof computeDelta>;
  note?: string | null;
}) {
  const trendNote =
    values.length < 3
      ? "Trend line appears once 3+ daily buckets are selected"
      : note;

  return (
    <HudCard label={label}>
      <div className="flex items-baseline gap-2">
        <span className="text-[22px] font-black leading-none tabular-nums text-text">
          {total}
        </span>
        {delta && <DeltaBadge delta={delta} />}
      </div>
      {values.length >= 3 ? (
        <Sparkline
          values={values}
          label={`${label} trend`}
          width={220}
          height={36}
        />
      ) : null}
      {trendNote ? <CaveatNote>{trendNote}</CaveatNote> : null}
    </HudCard>
  );
}

function TrendsSection({
  data,
  range,
  tokenCaveat,
}: {
  data: ActivityOverview;
  range: { startDate?: string; endDate?: string };
  tokenCaveat: string | null;
}) {
  const rawSeries = data.dailySeries;
  if (rawSeries.length === 0) return null;

  // Expand to a continuous day spine so sparklines/heatmap don't draw false
  // slopes across days with no activity. Only when the window is bounded; an
  // all-time range (no startDate) keeps the raw points.
  const series =
    range.startDate !== undefined
      ? fillDailySeries(
          rawSeries,
          range.startDate,
          range.endDate ?? new Date().toISOString().slice(0, 10),
        )
      : rawSeries;

  const prev = data.inference.previousSummary;
  const summary = data.inference.summary;
  const turnValues = series.map((d) => d.turnCount);
  const toolValues = series.map((d) => d.toolCallCount);
  const tokenValues = series.map((d) => d.inputTokens + d.outputTokens);
  const heatDays = series.map((d) => ({ date: d.date, value: d.turnCount }));

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Activity trends</SectionLabel>
      <div className="grid gap-4 lg:grid-cols-3">
        <TrendCard
          label="Turns / day"
          total={formatNumber(summary.turnCount)}
          values={turnValues}
          delta={computeDelta(summary.turnCount, prev?.turnCount ?? null)}
        />
        <TrendCard
          label="Tool calls / day"
          total={formatNumber(summary.toolCallCount)}
          values={toolValues}
          delta={computeDelta(
            summary.toolCallCount,
            prev?.toolCallCount ?? null,
          )}
        />
        <TrendCard
          label="Tokens / day"
          total={formatNumber(summary.inputTokens + summary.outputTokens)}
          values={tokenValues}
          delta={
            tokenCaveat === null
              ? computeDelta(
                  summary.inputTokens + summary.outputTokens,
                  prev ? prev.inputTokens + prev.outputTokens : null,
                )
              : undefined
          }
        />
      </div>
      <HudCard label="Turns per day">
        <Heatmap days={heatDays} label="Turns per day heatmap" />
      </HudCard>
    </div>
  );
}

function InferenceSection({
  data,
  tokenCaveat,
}: {
  data: ActivityOverview;
  tokenCaveat: string | null;
}) {
  const summary = data.inference.summary;
  const prev = data.inference.previousSummary;
  const tokens = totalTokens(summary);

  const allZero =
    summary.turnCount === 0 && summary.toolCallCount === 0 && tokens === 0;

  if (allZero) {
    return (
      <div className="flex flex-col gap-4">
        <SectionLabel>Inference &amp; tool usage</SectionLabel>
        <div className="flex flex-col items-center justify-center gap-2 rounded-[12px] border border-border bg-surface py-16 text-center">
          <span className="text-[14px] text-text-2">No activity yet</span>
          <span className="text-[12px] text-text-3">
            Usage data appears once your workbench has activity
          </span>
        </div>
      </div>
    );
  }

  const successfulTurns = summary.turnCount - summary.failedTurnCount;
  const successfulTools = summary.toolCallCount - summary.toolErrorCount;
  const turnRate = ratePct(successfulTurns, summary.turnCount);
  const toolRate = ratePct(successfulTools, summary.toolCallCount);
  const hitRate = cacheHitRate(summary.inputTokens, summary.cacheReadTokens);
  const thinkPct = ratePct(summary.thinkingTokens, tokens);
  const modelRows = data.models.filter((model) => model.count > 0);

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Inference &amp; tool usage</SectionLabel>
      {tokenCaveat !== null && <CaveatNote>{tokenCaveat}</CaveatNote>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Total turns"
          value={formatNumber(summary.turnCount)}
          delta={computeDelta(summary.turnCount, prev?.turnCount ?? null)}
          sub={`${turnRate.toFixed(1)}% success`}
          danger={summary.failedTurnCount > 0}
        />
        <Stat
          label="Tool calls"
          value={formatNumber(summary.toolCallCount)}
          delta={computeDelta(
            summary.toolCallCount,
            prev?.toolCallCount ?? null,
          )}
          sub={
            tokenCaveat === null
              ? `${toolRate.toFixed(1)}% success`
              : "success rate unavailable"
          }
          danger={tokenCaveat === null && summary.toolErrorCount > 0}
        />
        <Stat
          label="Cache hit rate"
          value={`${hitRate.toFixed(0)}%`}
          sub="of read tokens"
        />
        <Stat
          label="Thinking tokens"
          value={`${thinkPct.toFixed(0)}%`}
          sub="of all tokens"
        />
      </div>

      <HudCard
        label="Token mix"
        tag={
          tokens > 0 ? (
            <CardLabel>{formatNumber(tokens)} total</CardLabel>
          ) : undefined
        }
      >
        {tokens > 0 ? (
          <TokenMosaic
            label="Token usage breakdown"
            parts={[
              { label: "Input", value: summary.inputTokens },
              { label: "Output", value: summary.outputTokens },
              { label: "Cache read", value: summary.cacheReadTokens },
              { label: "Cache write", value: summary.cacheWriteTokens },
              { label: "Thinking", value: summary.thinkingTokens },
            ]}
          />
        ) : (
          <div className="flex flex-col items-start gap-2 py-2">
            <span className="text-[12px] text-text-2">
              No token data for this range
            </span>
            {tokenCaveat !== null && <CaveatNote>{tokenCaveat}</CaveatNote>}
          </div>
        )}
      </HudCard>

      {modelRows.length > 0 && (
        <HudCard
          label="Models · by turns"
          tag={
            modelRows.length > 8 ? (
              <CardLabel>{`+${modelRows.length - 8} more`}</CardLabel>
            ) : undefined
          }
        >
          <MiniBars
            label="Model distribution"
            rows={modelRows
              .slice(0, 8)
              .map((m) => ({ label: m.key, value: m.count }))}
          />
        </HudCard>
      )}
    </div>
  );
}

function EngagementSection({ data }: { data: ActivityOverview }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Engagement</SectionLabel>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Conversations"
          value={formatNumber(data.conversations.total)}
          sub={`${formatNumber(data.conversations.createdInRange)} in range`}
        />
        <Stat
          label="Messages"
          value={formatNumber(data.messages.total)}
          sub={`${formatNumber(data.messages.createdInRange)} in range`}
        />
        <Stat
          label="Active agents"
          value={formatNumber(data.agentActivity.active)}
          sub="with activity"
        />
        <Stat
          label="Idle agents"
          value={formatNumber(data.agentActivity.idle)}
          sub="of total instances"
        />
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="h-[96px] animate-pulse rounded-[12px] border border-border bg-surface-2" />
  );
}

function SkeletonGrid() {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      data-testid="insights-skeleton"
    >
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

function CountTable({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; count: number }[];
}) {
  return (
    <HudCard label={title}>
      {rows.length === 0 ? (
        <p className="text-[13px] text-text-3">None recorded</p>
      ) : (
        <table className="w-full text-left text-[13px]">
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="py-1.5 text-[12px] text-text-2">
                  {humanizeKey(row.key)}
                </td>
                <td className="py-1.5 text-right font-mono text-[12px] tabular-nums text-text">
                  {formatNumber(row.count)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </HudCard>
  );
}

function OperationalLedger({ data }: { data: ActivityOverview }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Operational ledger</SectionLabel>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label="Artifacts"
          value={formatNumber(data.artifacts.total)}
          sub={`${formatNumber(data.artifacts.createdInRange)} in range`}
        />
        <Stat
          label="Workflow runs"
          value={formatNumber(data.workflowRuns.executionRecords)}
          sub={`${formatNumber(data.workflowRuns.activeExecutions)} active`}
        />
        <Stat
          label="Agents deployed"
          value={formatNumber(data.agentInstances.total)}
          sub={`${formatNumber(data.agentInstances.active)} active`}
        />
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <CountTable
          title="Artifacts by status"
          rows={data.artifacts.byStatus}
        />
        <CountTable title="Artifacts by kind" rows={data.artifacts.byKind} />
        <CountTable
          title="Workflow runs by status"
          rows={data.workflowRuns.byStatus}
        />
        <CountTable
          title="Workflow runs by kind"
          rows={data.workflowRuns.byKind}
        />
      </div>
    </div>
  );
}

const INSTANCE_PAGE_SIZE = 10;

function InstanceBreakdown({
  instances,
}: {
  instances: ActivityOverview["inference"]["byInstance"];
}) {
  const [visibleCount, setVisibleCount] = useState(INSTANCE_PAGE_SIZE);

  if (instances.length === 0) return null;

  const visible = instances.slice(0, visibleCount);
  const remaining = instances.length - visible.length;

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>By agent instance</SectionLabel>
      <div className="overflow-x-auto rounded-[12px] border border-border">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead className="border-b border-border bg-surface text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">
            <tr>
              <th className="px-4 py-2 font-medium">Instance</th>
              <th className="px-4 py-2 font-medium">Agent</th>
              <th className="px-4 py-2 text-right font-medium">Turns</th>
              <th className="px-4 py-2 text-right font-medium">Tool calls</th>
              <th className="px-4 py-2 text-right font-medium">Tokens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-bg">
            {visible.map((row) => (
              <tr key={row.instanceId}>
                <td className="px-4 py-2 font-mono text-[12px] text-text-2">
                  {row.instanceId}
                </td>
                <td className="px-4 py-2 text-text">
                  {row.agentName ?? row.agentId}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-text-2">
                  {formatNumber(row.turnCount)}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-text-2">
                  {formatNumber(row.toolCallCount)}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-text-2">
                  {formatNumber(row.inputTokens + row.outputTokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {remaining > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-text-3">
            Showing {formatNumber(visible.length)} of{" "}
            {formatNumber(instances.length)}
          </span>
          <button
            type="button"
            onClick={() =>
              setVisibleCount((count) => count + INSTANCE_PAGE_SIZE)
            }
            className="flex min-h-[40px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-[color,background-color] duration-150 hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
          >
            Show {Math.min(remaining, INSTANCE_PAGE_SIZE)} more
          </button>
        </div>
      )}
    </div>
  );
}

export type WorkflowKindRow = {
  kind: string;
  runs: number;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Merges the per-kind run counts (`workflowRuns.byKind`) with the per-kind
 * inference usage (`byWorkflowType`) into one row per kind. Run counts and
 * usage come from two different joins, so a kind can appear in one and not the
 * other; the merge keeps every kind seen in either, zero-filling the missing
 * side. Exported for tests.
 */
export function mergeWorkflowKindRows(
  byKind: { key: string; count: number }[],
  byType: UsageByWorkflowTypeRow[],
): WorkflowKindRow[] {
  const usage = new Map(byType.map((row) => [row.kind, row]));
  const runs = new Map(byKind.map((row) => [row.key, row.count]));
  const kinds = new Set<string>([...runs.keys(), ...usage.keys()]);
  return [...kinds].map((kind) => {
    const u = usage.get(kind);
    return {
      kind,
      runs: runs.get(kind) ?? 0,
      turnCount: u?.turnCount ?? 0,
      toolCallCount: u?.toolCallCount ?? 0,
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
    };
  });
}

export function filterPeople(
  people: UsageByPersonRow[],
  filter: ActorFilter,
): UsageByPersonRow[] {
  if (filter === "me") return people.filter((p) => p.isSelf);
  if (filter === "others") return people.filter((p) => !p.isSelf);
  return people;
}

function KpiRow({
  data,
  activePeople,
  costTotal,
  costTokens,
  costUnavailable,
}: {
  data: ActivityOverview;
  activePeople: number;
  /** Total dollar cost from the resolved rate catalog, or null while unresolved. */
  costTotal: number | null;
  costTokens: number;
  /** True once pricing has been checked and no rate could be resolved for any usage. */
  costUnavailable: boolean;
}) {
  const summary = data.inference.summary;
  const prev = data.inference.previousSummary;
  const activity = summary.turnCount + summary.toolCallCount;
  const prevActivity = prev ? prev.turnCount + prev.toolCallCount : null;
  return (
    <div className="flex flex-col gap-4 rounded-[16px] border border-border bg-gradient-to-b from-surface-2 to-surface p-4 max-md:p-3">
      <SectionLabel>This range</SectionLabel>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat
          label="Cost"
          value={costTotal !== null ? formatDollars(costTotal) : "—"}
          sub={
            costUnavailable
              ? "pricing unavailable"
              : `${formatNumber(costTokens)} tokens`
          }
          emphasis
        />
        <Stat
          label="Total activity"
          value={formatNumber(activity)}
          sub="turns + tool calls"
          delta={computeDelta(activity, prevActivity)}
          emphasis
        />
        <Stat
          label="Active actors"
          value={formatNumber(activePeople)}
          sub="people with usage"
          emphasis
        />
        <Stat
          label="Workflow runs"
          value={formatNumber(data.workflowRuns.executionRecords)}
          sub={`${formatNumber(data.workflowRuns.activeExecutions)} active`}
          emphasis
        />
        <Stat
          label="Artifacts"
          value={formatNumber(data.artifacts.total)}
          sub={`${formatNumber(data.artifacts.createdInRange)} in range`}
          emphasis
        />
      </div>
    </div>
  );
}

function selectClass(): string {
  return "min-h-[40px] rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-text-2 outline-none focus-visible:ring-1 focus-visible:ring-accent";
}

function FiltersBar({
  kinds,
  kindFilter,
  onKindFilter,
  actorFilter,
  onActorFilter,
}: {
  kinds: string[];
  kindFilter: string;
  onKindFilter: (value: string) => void;
  actorFilter: ActorFilter;
  onActorFilter: (value: ActorFilter) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="filters-bar"
    >
      <label className="flex items-center gap-1.5 text-[11px] text-text-3">
        Kind
        <select
          data-testid="kind-filter"
          value={kindFilter}
          onChange={(e) => onKindFilter(e.target.value)}
          className={selectClass()}
        >
          <option value="all">All kinds</option>
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {humanizeKey(kind)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-text-3">
        Actor
        <select
          data-testid="actor-filter"
          value={actorFilter}
          onChange={(e) => onActorFilter(e.target.value as ActorFilter)}
          className={selectClass()}
        >
          <option value="all">Everyone</option>
          <option value="me">Just me</option>
          <option value="others">Others</option>
        </select>
      </label>
    </div>
  );
}

function ChartsSection({
  data,
  range,
  kindRows,
  people,
  tokenCaveat,
}: {
  data: ActivityOverview;
  range: DateRange;
  kindRows: WorkflowKindRow[];
  people: UsageByPersonRow[];
  tokenCaveat: string | null;
}) {
  const rawSeries = data.dailySeries;
  const filled =
    range.startDate !== undefined && rawSeries.length > 0
      ? fillDailySeries(
          rawSeries,
          range.startDate,
          range.endDate ?? new Date().toISOString().slice(0, 10),
        )
      : rawSeries;

  const activitySeries: TimeSeries[] = [
    {
      key: "turns",
      name: "Turns",
      points: filled.map((d) => ({ label: d.date, value: d.turnCount })),
    },
    {
      key: "tools",
      name: "Tool calls",
      points: filled.map((d) => ({ label: d.date, value: d.toolCallCount })),
    },
  ];

  const kindBars: CategoryDatum[] = kindRows
    .filter((row) => row.runs > 0)
    .sort((a, b) => b.runs - a.runs)
    .map((row) => ({ label: humanizeKey(row.kind), value: row.runs }));

  const actorBars: CategoryDatum[] = filterPeople(people, "all")
    .map((p) => ({
      label: p.name ?? "Unknown member",
      value: p.turnCount,
    }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Charts</SectionLabel>
      <HudCard label="Activity over time">
        <TimeSeriesChart
          series={activitySeries}
          label="Turns and tool calls per day"
          variant="area"
        />
      </HudCard>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <HudCard label="Workflow runs by kind">
          <CategoryBarChart
            data={kindBars}
            label="Workflow runs by kind"
            colorByCategory
            formatValue={formatNumber}
          />
        </HudCard>
        <HudCard
          label="Top actors · by turns"
          tag={
            tokenCaveat !== null ? (
              <CardLabel>tokens partial</CardLabel>
            ) : undefined
          }
        >
          <CategoryBarChart
            data={actorBars}
            label="Top actors by turns"
            maxBars={8}
            formatValue={formatNumber}
          />
        </HudCard>
      </div>
    </div>
  );
}

function SortablePersonTable({ people }: { people: UsageByPersonRow[] }) {
  const columns: SortableColumn<UsageByPersonRow>[] = [
    {
      key: "name",
      header: "Person",
      sortValue: (r) => (r.name ?? "Unknown member").toLowerCase(),
      render: (row) => (
        <span>
          <Link
            to={actorHref(row.principalId)}
            state={{
              id: row.principalId,
              kind: "user",
              displayName: row.name ?? "Unknown member",
              status: "active",
            }}
            className="rounded-[4px] outline-none hover:text-accent hover:underline focus-visible:ring-1 focus-visible:ring-accent"
          >
            {row.name ?? "Unknown member"}
          </Link>
          {row.isSelf && (
            <span className="ml-1.5 text-[11px] font-semibold text-accent">
              (me)
            </span>
          )}
        </span>
      ),
    },
    {
      key: "turnCount",
      header: "Turns",
      align: "right",
      sortValue: (r) => r.turnCount,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.turnCount)}
        </span>
      ),
    },
    {
      key: "toolCallCount",
      header: "Tool calls",
      align: "right",
      sortValue: (r) => r.toolCallCount,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.toolCallCount)}
        </span>
      ),
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      sortValue: (r) => r.inputTokens + r.outputTokens,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.inputTokens + r.outputTokens)}
        </span>
      ),
    },
  ];
  return (
    <SortableTable
      columns={columns}
      rows={people}
      getRowKey={(r) => r.principalId}
      caption="Usage by person"
      initialSort={{ key: "tokens", dir: "desc" }}
      pageSize={10}
      emptyMessage="No attributed usage for this range"
    />
  );
}

function SortableWorkflowKindTable({ rows }: { rows: WorkflowKindRow[] }) {
  const columns: SortableColumn<WorkflowKindRow>[] = [
    {
      key: "kind",
      header: "Workflow kind",
      sortValue: (r) => r.kind,
      render: (r) => humanizeKey(r.kind),
    },
    {
      key: "runs",
      header: "Runs",
      align: "right",
      sortValue: (r) => r.runs,
      render: (r) => (
        <span className="font-mono tabular-nums">{formatNumber(r.runs)}</span>
      ),
    },
    {
      key: "turnCount",
      header: "Turns",
      align: "right",
      sortValue: (r) => r.turnCount,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.turnCount)}
        </span>
      ),
    },
    {
      key: "toolCallCount",
      header: "Tool calls",
      align: "right",
      sortValue: (r) => r.toolCallCount,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.toolCallCount)}
        </span>
      ),
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      sortValue: (r) => r.inputTokens + r.outputTokens,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.inputTokens + r.outputTokens)}
        </span>
      ),
    },
  ];
  return (
    <SortableTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.kind}
      caption="Workflow runs by kind"
      initialSort={{ key: "runs", dir: "desc" }}
      pageSize={10}
      emptyMessage="No workflow runs for this range"
    />
  );
}

// Light staggered fade for the dashboard sections as they mount after the
// loading skeleton, instead of a hard cut. Subtle (short durations + small
// offset); reduced-motion collapses it to an instant show (see below).
const SECTIONS_CONTAINER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.03 } },
};
const SECTION_ITEM: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: "easeOut" } },
};

export function InsightsDashboard() {
  const [preset, setPreset] = useState<Preset>("30d");
  const [customRange, setCustomRange] = useState<DateRange>({});
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [actorFilter, setActorFilter] = useState<ActorFilter>("all");
  const { activeTenantId, activeWorkbench, loading } = useActiveWorkbench();
  const reduceMotion = useReducedMotion();
  const pricingQuery = useModelPricing(activeTenantId ?? "");

  const dates = resolveRange(preset, customRange);

  const overviewQuery = useQuery({
    queryKey: [
      "activity-overview",
      activeTenantId,
      dates.startDate ?? null,
      dates.endDate ?? null,
    ],
    queryFn: () => getActivityOverview(activeTenantId!, dates),
    enabled: !!activeTenantId,
    staleTime: 5 * 60_000,
  });

  const showSummaryLoading =
    loading || (!!activeTenantId && overviewQuery.isLoading);

  const overview = overviewQuery.data;
  const tokenCaveat = overview
    ? tokenDataCaveat(dates, overview.tokensRecordedFrom)
    : null;

  const kindRows = useMemo(
    () =>
      overview
        ? mergeWorkflowKindRows(
            overview.workflowRuns.byKind,
            overview.byWorkflowType,
          )
        : [],
    [overview],
  );
  const workflowKinds = useMemo(
    () =>
      [...new Set(kindRows.map((r) => r.kind))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [kindRows],
  );
  const filteredKindRows =
    kindFilter === "all"
      ? kindRows
      : kindRows.filter((r) => r.kind === kindFilter);
  const filteredPeople = overview
    ? filterPeople(overview.byPerson, actorFilter)
    : [];

  const catalog = pricingQuery.data ?? null;
  const priced =
    overview && catalog ? priceUsageRows(overview.byModel, catalog) : null;
  const costTokens = overview
    ? overview.byModel.reduce(
        (sum, row) =>
          sum +
          row.inputTokens +
          row.outputTokens +
          row.cacheReadTokens +
          row.cacheWriteTokens,
        0,
      )
    : 0;
  const costUnavailable =
    pricingQuery.isError ||
    (pricingQuery.isSuccess && Object.keys(catalog?.models ?? {}).length === 0);

  return (
    <PagePanel scroll={false} flat>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3 max-md:px-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-4 w-4 shrink-0 text-text-3" />
            <p className="text-[14px] font-semibold text-text">
              Data &amp; Insights
            </p>
          </div>
          {activeWorkbench && (
            <p className="truncate pl-6 text-[12px] text-text-3">
              {activeWorkbench.tenantName}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPreset(p.value)}
                className={`flex min-h-[40px] items-center rounded-[8px] px-3 py-1.5 text-[12px] font-medium transition-[color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] ${
                  preset === p.value
                    ? "bg-accent/10 text-accent"
                    : "text-text-3 hover:bg-row-hover hover:text-text"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === "custom" && (
            <div
              className="flex items-center gap-1.5"
              data-testid="custom-range"
            >
              <input
                type="date"
                aria-label="Start date"
                data-testid="custom-start"
                value={customRange.startDate ?? ""}
                onChange={(e) =>
                  setCustomRange((r) => ({ ...r, startDate: e.target.value }))
                }
                className={selectClass()}
              />
              <span className="text-[12px] text-text-3">to</span>
              <input
                type="date"
                aria-label="End date"
                data-testid="custom-end"
                value={customRange.endDate ?? ""}
                onChange={(e) =>
                  setCustomRange((r) => ({ ...r, endDate: e.target.value }))
                }
                className={selectClass()}
              />
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 max-md:px-3">
        {showSummaryLoading && <SkeletonGrid />}

        {!loading && !activeTenantId && (
          <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
            Select a workbench to view analytics.
          </div>
        )}

        {overviewQuery.isError && (
          <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
            {describeHubApiFailure(overviewQuery.error)}
          </div>
        )}

        {overview && (
          <motion.div
            className="flex flex-col gap-10"
            variants={SECTIONS_CONTAINER}
            initial={reduceMotion ? false : "hidden"}
            animate="show"
          >
            <motion.div variants={SECTION_ITEM}>
              <KpiRow
                data={overview}
                activePeople={overview.byPerson.length}
                costTotal={priced?.cost.total ?? null}
                costTokens={costTokens}
                costUnavailable={costUnavailable}
              />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <FiltersBar
                kinds={workflowKinds}
                kindFilter={kindFilter}
                onKindFilter={setKindFilter}
                actorFilter={actorFilter}
                onActorFilter={setActorFilter}
              />
            </motion.div>
            {activeTenantId && (
              <motion.div variants={SECTION_ITEM}>
                <CostInsights
                  tenantId={activeTenantId}
                  overview={overview}
                  range={dates}
                  tokenCaveat={tokenCaveat}
                />
              </motion.div>
            )}
            {/* Actor search + per-principal timeline; independent query lifecycle
                from the 5-min-stale overview above. CL-2526 (trace pages +
                recent-activity feed) inserts alongside this section. */}
            {activeTenantId && (
              <motion.div variants={SECTION_ITEM}>
                <SectionLabel>Activity</SectionLabel>
                <div className="mt-4 flex flex-col gap-10">
                  <ActorActivitySection tenantId={activeTenantId} />
                  {/* CL-2526 Recent Activity feed: a reverse-chronological slice
                      for the current user's principal, each workflow_run row
                      deep-linking to its trace page. Self-contained; own query
                      lifecycle. A tenant-wide feed needs a new hub endpoint
                      (follow-up). */}
                  {activeWorkbench && (
                    <RecentActivity
                      tenantId={activeTenantId}
                      principalId={activeWorkbench.id}
                    />
                  )}
                </div>
              </motion.div>
            )}
            <motion.div variants={SECTION_ITEM}>
              <ChartsSection
                data={overview}
                range={dates}
                kindRows={filteredKindRows}
                people={filteredPeople}
                tokenCaveat={tokenCaveat}
              />
            </motion.div>
            <motion.div className="flex flex-col gap-3" variants={SECTION_ITEM}>
              <SectionLabel>Usage by person</SectionLabel>
              {tokenCaveat !== null && <CaveatNote>{tokenCaveat}</CaveatNote>}
              <SortablePersonTable people={filteredPeople} />
              <p className="text-[11px] text-text-3">Excludes shared agents</p>
            </motion.div>
            <motion.div className="flex flex-col gap-3" variants={SECTION_ITEM}>
              <SectionLabel>Workflow runs by kind</SectionLabel>
              <SortableWorkflowKindTable rows={filteredKindRows} />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <TrendsSection
                data={overview}
                range={dates}
                tokenCaveat={tokenCaveat}
              />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <EngagementSection data={overview} />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <InferenceSection data={overview} tokenCaveat={tokenCaveat} />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <OperationalLedger data={overview} />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <InstanceBreakdown instances={overview.inference.byInstance} />
            </motion.div>
          </motion.div>
        )}
      </div>
    </PagePanel>
  );
}
