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
import { BarChart2, Download } from "lucide-react";

import { actorHref } from "./insights/ActorActivity";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { useModelPricing } from "../hooks/use-model-pricing";
import {
  describeHubApiFailure,
  downloadActivityExportCsv,
  getActivityOverview,
  type ActivityExportBucket,
} from "../lib/hub-api";
import type {
  ActivityOverview,
  UsageByPersonRow,
  UsageByWorkflowTypeRow,
} from "../lib/hub-api";
import { ActorActivitySection } from "./insights/ActorActivity";
import { CostInsights } from "./insights/CostInsights";
import { DeferredActivitySection } from "./insights/DeferredActivitySection";
import { TenantRoster } from "./insights/TenantRoster";
import { SectionLabel } from "./insights/section-label";

import {
  fillDailySeries,
  humanizeKey,
  resolveTenantPricedByModel,
  sumInferenceTokenClasses,
  tokenDataCaveat,
} from "./insights/metrics";
import { TimeRangeControls } from "./insights/TimeRangeControls";
import { KpiRow } from "./insights/KpiRow";
import { TrendsSection } from "./insights/TrendsSection";
import { InferenceSection } from "./insights/InferenceSection";
import { OperationalLedger } from "./insights/OperationalLedger";
import { InstanceBreakdown } from "./insights/InstanceBreakdown";
import { EngagementSection } from "./insights/EngagementSection";
import { CardLabel, CaveatNote, formatNumber, HudCard } from "./insights/stats";
import type { Preset, DateRange } from "./insights/time-range";
import { resolveRange, selectClass } from "./insights/time-range";

// Re-export for existing tests and callers that import from this module.
export { resolveRange } from "./insights/time-range";

/** Actor-kind filter for the person-scoped views. */
type ActorFilter = "all" | "me" | "others";

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

export type WorkflowKindRow = {
  kind: string;
  runs: number;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
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
      cacheReadTokens: u?.cacheReadTokens ?? 0,
      cacheWriteTokens: u?.cacheWriteTokens ?? 0,
      thinkingTokens: u?.thinkingTokens ?? 0,
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
      sortValue: (r) => sumInferenceTokenClasses(r),
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(sumInferenceTokenClasses(r))}
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
      sortValue: (r) => sumInferenceTokenClasses(r),
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(sumInferenceTokenClasses(r))}
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
  const [exportBucket, setExportBucket] = useState<ActivityExportBucket>("day");
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
  const priced = useMemo(
    () => (overview ? resolveTenantPricedByModel(overview, catalog) : null),
    [overview, catalog],
  );
  const costTokens = overview
    ? sumInferenceTokenClasses(overview.inference.summary)
    : 0;
  const costUnavailable =
    !!overview &&
    overview.byModel.length > 0 &&
    priced === null &&
    (pricingQuery.isError || pricingQuery.isFetched);

  const canExport = (overview?.metricsSeries.length ?? 0) > 0;
  const exportCsv = () => {
    if (!activeTenantId || !canExport) return;
    void downloadActivityExportCsv(activeTenantId, {
      ...dates,
      bucket: exportBucket,
    })
      .then(({ csv, filename }) => {
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      })
      .catch(() => {});
  };

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
          <TimeRangeControls
            preset={preset}
            onPresetChange={setPreset}
            customRange={customRange}
            onCustomRangeChange={setCustomRange}
          />
          <select
            aria-label="Export bucket"
            data-testid="export-bucket"
            value={exportBucket}
            onChange={(e) =>
              setExportBucket(e.target.value as ActivityExportBucket)
            }
            className={selectClass()}
          >
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!canExport}
            title={
              canExport
                ? "Download metrics and usage breakdowns as CSV"
                : "No metrics to export for this range"
            }
            className="flex min-h-[40px] items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12px] font-medium text-text-3 transition-[color,background-color] duration-150 hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-3"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
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
              <ChartsSection
                data={overview}
                range={dates}
                kindRows={filteredKindRows}
                people={filteredPeople}
                tokenCaveat={tokenCaveat}
              />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <TrendsSection
                data={overview}
                range={dates}
                tokenCaveat={tokenCaveat}
              />
            </motion.div>
            {activeTenantId && (
              <motion.div variants={SECTION_ITEM}>
                <CostInsights
                  tenantId={activeTenantId}
                  overview={overview}
                  range={dates}
                  tokenCaveat={tokenCaveat}
                  priced={priced}
                  catalog={catalog}
                  pricingUnavailable={costUnavailable}
                  pricingLoading={pricingQuery.isLoading}
                />
              </motion.div>
            )}
            <motion.div variants={SECTION_ITEM}>
              <FiltersBar
                kinds={workflowKinds}
                kindFilter={kindFilter}
                onKindFilter={setKindFilter}
                actorFilter={actorFilter}
                onActorFilter={setActorFilter}
              />
            </motion.div>
            {/* MIDDLE band — the big tenant-wide activity feed. Every row
                click-throughs into that entity's own trace. Per-principal is a
                drill-down: the actor search below routes to /insights/users/:id. */}
            {activeTenantId && (
              <motion.div variants={SECTION_ITEM}>
                <TenantRoster tenantId={activeTenantId} />
              </motion.div>
            )}
            {activeTenantId && (
              <motion.div variants={SECTION_ITEM}>
                <SectionLabel>Activity</SectionLabel>
                <div className="mt-4 flex flex-col gap-10">
                  <DeferredActivitySection tenantId={activeTenantId} />
                  <ActorActivitySection tenantId={activeTenantId} />
                </div>
              </motion.div>
            )}
            <motion.div variants={SECTION_ITEM}>
              <KpiRow
                data={overview}
                activePeople={overview.byPerson.length}
                costTotal={priced?.cost.total ?? null}
                costTokens={costTokens}
                costUnavailable={costUnavailable}
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
