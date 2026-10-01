// The bench-scoped Insights dashboard: every number is computed from the
// stock `GET /workflows/runs` listing of the bench's own tenant.

import { RichEmptyState, Skeleton } from "@corbits/react-ui";
import { cronSentence } from "@corbits/workflows/client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ApprovalsCard } from "../bench/approvals-insights";
import { apiQueryOptions, ArtifactListPageSchema, useAPIQuery } from "../api";
import {
  insightsRunEventsPath,
  insightsTopLevelRunsPath,
  RunEventsSchema,
  runFailureMessage,
  TopLevelRunsSchema,
  type InsightsRun,
} from "../insights-api";
import {
  approvalRunsInRange,
  BENCH_RANGES,
  benchInsightTiles,
  computeBenchInsights,
  countSavedArtifacts,
  durationLabel,
  formatCount,
  runDisplayName,
  type BenchDay,
  type BenchRange,
} from "../insights-stats";
import { X } from "../lib/icons";
import { tenantKeys } from "../query-client";
import { listCronSchedules } from "../routines-api";
import { formatWhen } from "./insights-page";
import { useFromBench } from "../shell/page-crumbs";
import { PageLayout } from "../shell/page-layout";
import { StageTopBar } from "../shell/stage-top-bar";
import { workbenchPath } from "../workbench-path";

import "./bench-insights.css";

const RANGE_LABEL: Readonly<Record<BenchRange, string>> = {
  7: "Last 7 days",
  30: "Last 30 days",
  90: "Last 90 days",
};

const COMING_LATER = [
  ["Tokens and cost", "Per worker, per workflow, per model"],
  ["Tool calls", "Which tools ran, how often, and which failed"],
  ["Latency", "Time to first reply and time per step"],
] as const;

function dayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function OutcomeChart({
  days,
  weekdayAxis = false,
}: {
  readonly days: readonly BenchDay[];
  /** Weekday initials on the axis, for the drawer's 7-day chart. */
  readonly weekdayAxis?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.ok + d.fail + d.other), 1);
  const every = days.length > 30 ? 14 : days.length > 7 ? 5 : 1;
  const shown = active === null ? undefined : days[active];
  if (days.every((d) => d.ok + d.fail + d.other === 0)) {
    return <div className="bi-chart-empty">No runs in this range.</div>;
  }
  return (
    <div className="bi-chart">
      <div className="bi-legend">
        <span>
          <i style={{ background: "var(--chart-ok, #3B6FA8)" }} />
          Succeeded
        </span>
        <span>
          <i style={{ background: "var(--chart-fail, #A4453D)" }} />
          Failed
        </span>
      </div>
      <div className="bi-bars" style={{ gap: days.length > 30 ? 1 : 4 }}>
        {days.map((d, i) => (
          <div
            key={d.date.getTime()}
            className="bi-col"
            tabIndex={0}
            role="img"
            aria-label={`${dayLabel(d.date)}: ${d.ok} succeeded, ${d.fail} failed, ${d.other} running or stopped`}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            {d.ok > 0 ? (
              <i
                style={{
                  height: `${(d.ok / max) * 100}%`,
                  background: "var(--chart-ok, #3B6FA8)",
                }}
              />
            ) : null}
            {d.fail > 0 ? (
              <i
                style={{
                  height: `${(d.fail / max) * 100}%`,
                  background: "var(--chart-fail, #A4453D)",
                }}
              />
            ) : null}
            {d.other > 0 ? (
              <i className="bi-other" style={{ height: `${(d.other / max) * 100}%` }} />
            ) : null}
          </div>
        ))}
      </div>
      <div className="bi-x" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.date.getTime()}>
            {weekdayAxis
              ? d.date.toLocaleDateString("en-US", { weekday: "narrow" })
              : i % every === 0
                ? `${d.date.getMonth() + 1}/${d.date.getDate()}`
                : ""}
          </span>
        ))}
      </div>
      {shown !== undefined && active !== null ? (
        <div
          className="bi-tip"
          role="tooltip"
          style={{ left: `${((active + 0.5) / days.length) * 100}%` }}
        >
          <b>{dayLabel(shown.date)}</b>
          {shown.ok} succeeded · {shown.fail} failed · {shown.other} other
        </div>
      ) : null}
    </div>
  );
}

function Meter({
  ok,
  fail,
  total,
}: {
  readonly ok: number;
  readonly fail: number;
  readonly total: number;
}) {
  return (
    <span className="bi-meter" aria-hidden="true">
      <i
        style={{
          width: `${(ok / total) * 100}%`,
          background: "var(--chart-ok, #3B6FA8)",
        }}
      />
      {fail > 0 ? (
        <i
          style={{
            width: `${(fail / total) * 100}%`,
            background: "var(--chart-fail, #A4453D)",
          }}
        />
      ) : null}
    </span>
  );
}

export function BenchInsights({
  tenantId,
  workbenchId,
  title,
  onOpenRun,
}: {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly title: string;
  readonly onOpenRun: (id: string) => void;
}) {
  const [range, setRange] = useState<BenchRange>(7);
  const runs = useAPIQuery(insightsTopLevelRunsPath(tenantId), TopLevelRunsSchema);
  // `?from=` already prefixes the bench's own crumb; without it the trail
  // names the bench itself, so it never shows twice.
  const from = useFromBench();
  const crumbs =
    from === workbenchId
      ? [{ label: "Insights" }]
      : [{ label: title, href: workbenchPath(workbenchId) }, { label: "Insights" }];

  const rangeSeg = (
    <div className="bi-seg" role="tablist" aria-label="Range">
      {BENCH_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          role="tab"
          aria-selected={r === range}
          aria-label={RANGE_LABEL[r]}
          title={RANGE_LABEL[r]}
          className={r === range ? "active" : ""}
          onClick={() => setRange(r)}
        >
          {r}d
        </button>
      ))}
    </div>
  );

  let body: ReactNode;
  if (runs.kind === "loading") {
    body = <Skeleton className="skeleton-panel-lg" />;
  } else if (runs.kind !== "ready") {
    body = (
      <RichEmptyState
        title="Couldn't load insights"
        description="Something went wrong on our side. Try again in a moment."
        {...(runs.kind === "error" ? { actions: [{ label: "Retry", onClick: runs.retry }] } : {})}
      />
    );
  } else {
    body = (
      <InsightsBody tenantId={tenantId} runs={runs.data} range={range} onOpenRun={onOpenRun} />
    );
  }

  return (
    <div className="page-frame">
      <StageTopBar crumbs={crumbs} actions={rangeSeg} />
      <div className="page-scroll">
        <PageLayout title="Insights" subtitle={`What happened in ${title}.`}>
          {body}
        </PageLayout>
      </div>
    </div>
  );
}

function InsightsBody({
  tenantId,
  runs,
  range,
  onOpenRun,
}: {
  readonly tenantId: string;
  readonly runs: { readonly data: readonly InsightsRun[]; readonly nextCursor: string | null };
  readonly range: BenchRange;
  readonly onOpenRun: (id: string) => void;
}) {
  const stats = computeBenchInsights(runs.data, range);
  const approvalRuns = approvalRunsInRange(runs.data, range);
  const artifacts = useAPIQuery(`/api/tenants/${tenantId}/artifacts`, ArtifactListPageSchema);
  const schedules = useQuery({
    queryKey: tenantKeys.schedules(tenantId),
    queryFn: () => listCronSchedules(tenantId),
  });
  const scheduleByDefinition = new Map(
    (schedules.data ?? [])
      .filter((row) => row.stoppedAt === null)
      .map((row) => [row.definitionName, row]),
  );
  const failureEvents = useQueries({
    queries: stats.failures.map((run) =>
      apiQueryOptions(insightsRunEventsPath(tenantId, run.id), RunEventsSchema),
    ),
  });
  const rangeStart = stats.days[0]?.date.getTime() ?? 0;
  const savedCount =
    artifacts.kind === "ready"
      ? formatCount(countSavedArtifacts(artifacts.data.artifacts, rangeStart))
      : "—";
  const tiles = benchInsightTiles(stats, savedCount);

  return (
    <div className="bi-page">
      {runs.nextCursor !== null ? (
        <p className="bi-sub">Figures reflect the 100 most recent runs — more exist.</p>
      ) : null}

      <div className="bi-stats">
        {tiles.map(([label, value]) => (
          <div key={label} className="bi-stat">
            <div className="bi-stat-v">{value}</div>
            <div className="bi-stat-k">{label}</div>
          </div>
        ))}
      </div>

      <div className="bi-grid">
        <section className="bi-panel">
          <h3>Runs per day</h3>
          <p className="bi-sub">
            Every workflow and conversation run in this workbench, by how it ended.
          </p>
          <OutcomeChart days={stats.days} />
        </section>
        <ApprovalsCard tenantId={tenantId} runs={approvalRuns.runs} capped={approvalRuns.capped} />
      </div>

      <section className="bi-panel bi-panel--flush">
        <div className="bi-panel-head">
          <h3>By workflow</h3>
          <p className="bi-sub">
            Median time from start to finish. Next run comes from the schedule.
          </p>
        </div>
        {stats.workflows.length === 0 ? (
          <p className="bi-empty">Nothing ran in the last {range} days.</p>
        ) : (
          <div className="bi-scroll">
            <table className="bi-table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Runs</th>
                  <th>Succeeded</th>
                  <th>Median</th>
                  <th>Last run</th>
                  <th>Next run</th>
                </tr>
              </thead>
              <tbody>
                {stats.workflows.map((w) => {
                  const done = w.ok + w.fail;
                  return (
                    <tr key={w.key}>
                      <td>
                        <strong>{w.name}</strong>
                      </td>
                      <td>{w.runs}</td>
                      <td>
                        {done === 0 ? (
                          "—"
                        ) : (
                          <>
                            <Meter ok={w.ok} fail={w.fail} total={done} />
                            {Math.round((w.ok / done) * 100)}%
                          </>
                        )}
                      </td>
                      <td>{w.medianMs === null ? "—" : durationLabel(w.medianMs)}</td>
                      <td>{formatWhen(w.lastRun)}</td>
                      <td>
                        {(() => {
                          const row = scheduleByDefinition.get(w.definitionName);
                          if (row === undefined) return "—";
                          if (!row.enabled) return <span className="bi-paused">Paused</span>;
                          return cronSentence(row.expression) ?? row.expression;
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bi-panel bi-panel--flush">
        <div className="bi-panel-head">
          <h3>Recent failures</h3>
          <p className="bi-sub">Open one to see the run and retry it.</p>
        </div>
        {stats.failures.length === 0 ? (
          <p className="bi-empty">No failures in the last {range} days.</p>
        ) : (
          <ul className="bi-fails">
            {stats.failures.map((run, i) => {
              const events = failureEvents[i]?.data?.events;
              const why = events === undefined ? null : runFailureMessage(events);
              return (
                <li key={run.id}>
                  <button type="button" onClick={() => onOpenRun(run.id)}>
                    <span className="bi-x-ic">
                      <X size={16} aria-hidden="true" />
                    </span>
                    <span>
                      <b>{runDisplayName(run)}</b>
                      <span className="bi-why">{why ?? "The run failed."}</span>
                    </span>
                    <span className="bi-when">{formatWhen(run.createdAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h3 className="bi-later-h">Coming later</h3>
        <p className="bi-sub">These need usage data the platform doesn't report yet.</p>
        <div className="bi-soon">
          {COMING_LATER.map(([title, detail]) => (
            <div key={title}>
              <b>{title}</b>
              <span>{detail}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
