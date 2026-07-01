import { PagePanel } from "@workbench/ui";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BarChart2 } from "lucide-react";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { describeHubApiFailure, getActivityOverview } from "../lib/hub-api";
import type {
  ActivityOverview,
  AnalyticsAgentRow,
  AnalyticsSummary,
  UsageByPersonRow,
} from "../lib/hub-api";
import {
  DeltaBadge,
  Heatmap,
  MiniBars,
  Sparkline,
  TokenMosaic,
} from "./insights/viz";
import {
  cacheHitRate,
  computeDelta,
  fillDailySeries,
  humanizeKey,
  ratePct,
  tokenDataCaveat,
} from "./insights/metrics";

type Preset = "24h" | "7d" | "30d" | "90d" | "all";

const PRESETS: { label: string; value: Preset }[] = [
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
  { label: "All time", value: "all" },
];

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// Analytics are bucketed by calendar day, so "24 hours" resolves to a
// startDate one day back — today plus yesterday inclusive, matching the other
// presets' N-days-ago convention and avoiding an empty view just after
// midnight.
const PRESET_DAYS: Record<Exclude<Preset, "all">, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function presetToDates(preset: Preset): {
  startDate?: string;
  endDate?: string;
} {
  if (preset === "all") return {};
  return { startDate: daysAgoISO(PRESET_DAYS[preset]) };
}

function formatNumber(n: number): string {
  return n.toLocaleString();
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
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
      {children}
    </h2>
  );
}

function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">
      {children}
    </span>
  );
}

function CaveatNote({ children }: { children: React.ReactNode }) {
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

function HudCard({
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

function Stat({
  label,
  value,
  sub,
  delta,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: ReturnType<typeof computeDelta>;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[12px] border border-border bg-surface p-4">
      <CardLabel>{label}</CardLabel>
      <div className="flex items-baseline gap-2">
        <span
          className={`text-[26px] font-black leading-none tabular-nums ${accent ? "text-accent" : "text-text"}`}
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
  return (
    <HudCard label={label}>
      <div className="flex items-baseline gap-2">
        <span className="text-[22px] font-black leading-none tabular-nums text-text">
          {total}
        </span>
        {delta && <DeltaBadge delta={delta} />}
      </div>
      <Sparkline
        values={values}
        label={`${label} trend`}
        width={220}
        height={36}
      />
      {note ? <CaveatNote>{note}</CaveatNote> : null}
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
          accent={summary.failedTurnCount > 0}
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
          accent={tokenCaveat === null && summary.toolErrorCount > 0}
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

      {data.models.length > 0 && (
        <HudCard
          label="Models · by turns"
          tag={
            data.models.length > 8 ? (
              <CardLabel>{`+${data.models.length - 8} more`}</CardLabel>
            ) : undefined
          }
        >
          <MiniBars
            label="Model distribution"
            rows={data.models
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
          accent
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
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

function PersonBreakdown({
  people,
  tokenCaveat,
}: {
  people: UsageByPersonRow[];
  tokenCaveat: string | null;
}) {
  if (people.length === 0) return null;

  // Server sorts by total tokens; tokens are always shown (a caveat note flags
  // ranges that predate token recording) so the ordering is always explainable.
  const orderedPeople = people;

  const totals = people.reduce(
    (acc, p) => ({
      turnCount: acc.turnCount + p.turnCount,
      toolCallCount: acc.toolCallCount + p.toolCallCount,
      inputTokens: acc.inputTokens + p.inputTokens,
      outputTokens: acc.outputTokens + p.outputTokens,
    }),
    { turnCount: 0, toolCallCount: 0, inputTokens: 0, outputTokens: 0 },
  );

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>By person</SectionLabel>
      {tokenCaveat !== null && <CaveatNote>{tokenCaveat}</CaveatNote>}
      <div className="overflow-x-auto rounded-[12px] border border-border">
        <table className="w-full min-w-[520px] text-left text-[13px]">
          <thead className="border-b border-border bg-surface text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">
            <tr>
              <th className="px-4 py-2 font-medium">Person</th>
              <th className="px-4 py-2 text-right font-medium">Turns</th>
              <th className="px-4 py-2 text-right font-medium">Tool calls</th>
              <th className="px-4 py-2 text-right font-medium">Tokens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-bg">
            {orderedPeople.map((row) => (
              <tr key={row.principalId}>
                <td className="px-4 py-2 text-text">
                  {row.name ?? "Unknown member"}
                  {row.isSelf && (
                    <span className="ml-1.5 text-[11px] font-semibold text-accent">
                      (me)
                    </span>
                  )}
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
          <tfoot className="border-t border-border bg-surface">
            <tr>
              <td className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-3">
                Attributed total
              </td>
              <td className="px-4 py-2 text-right font-mono tabular-nums text-text">
                {formatNumber(totals.turnCount)}
              </td>
              <td className="px-4 py-2 text-right font-mono tabular-nums text-text">
                {formatNumber(totals.toolCallCount)}
              </td>
              <td className="px-4 py-2 text-right font-mono tabular-nums text-text">
                {formatNumber(totals.inputTokens + totals.outputTokens)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[11px] text-text-3">Excludes shared agents</p>
    </div>
  );
}

function AgentBreakdown({ agents }: { agents: AnalyticsAgentRow[] }) {
  if (agents.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>By agent</SectionLabel>
      <div className="overflow-x-auto rounded-[12px] border border-border">
        <table className="w-full min-w-[480px] text-left text-[13px]">
          <thead className="border-b border-border bg-surface text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">
            <tr>
              <th className="px-4 py-2 font-medium">Agent</th>
              <th className="px-4 py-2 text-right font-medium">Turns</th>
              <th className="px-4 py-2 text-right font-medium">Tool calls</th>
              <th className="px-4 py-2 text-right font-medium">Tokens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-bg">
            {agents.map((row) => (
              <tr key={row.agentId}>
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
            {instances.map((row) => (
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
            className="flex min-h-[32px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-[color,background-color] duration-150 hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
          >
            Show {Math.min(remaining, INSTANCE_PAGE_SIZE)} more
          </button>
        </div>
      )}
    </div>
  );
}

export function InsightsDashboard() {
  const [preset, setPreset] = useState<Preset>("30d");
  const { activeTenantId, activeWorkbench, loading } = useActiveWorkbench();

  const dates = presetToDates(preset);

  const overviewQuery = useQuery({
    queryKey: ["activity-overview", activeTenantId, preset],
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
                className={`flex min-h-[32px] items-center rounded-[8px] px-3 py-1.5 text-[12px] font-medium transition-[color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] ${
                  preset === p.value
                    ? "bg-accent/10 text-accent"
                    : "text-text-3 hover:bg-row-hover hover:text-text"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 max-md:px-3">
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
          <div className="flex flex-col gap-10">
            <TrendsSection
              data={overview}
              range={dates}
              tokenCaveat={tokenCaveat}
            />
            <EngagementSection data={overview} />
            <InferenceSection data={overview} tokenCaveat={tokenCaveat} />
            <OperationalLedger data={overview} />
            <div className="flex flex-col gap-4">
              <PersonBreakdown
                people={overview.byPerson}
                tokenCaveat={tokenCaveat}
              />
              <AgentBreakdown agents={overview.inference.byAgent} />
              <InstanceBreakdown instances={overview.inference.byInstance} />
            </div>
          </div>
        )}
      </div>
    </PagePanel>
  );
}
