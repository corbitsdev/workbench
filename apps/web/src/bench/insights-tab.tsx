import { RichEmptyState, Skeleton } from "@corbits/react-ui";
import { useQueries } from "@tanstack/react-query";

import { apiQueryOptions, ArtifactListPageSchema, useAPIQuery } from "../api";
import {
  insightsRunEventsPath,
  insightsTopLevelRunsPath,
  RunEventsSchema,
  runFailureMessage,
  TopLevelRunsSchema,
} from "../insights-api";
import { runDetailPath, workbenchInsightsPath } from "../insights-deeplinks";
import {
  benchInsightTiles,
  computeBenchInsights,
  countSavedArtifacts,
  formatCount,
  runDisplayName,
} from "../insights-stats";
import { X } from "../lib/icons";
import { Link } from "../navigation";
import { OutcomeChart } from "../pages/bench-insights";
import { formatWhen } from "../pages/insights-page";
import { benchLink } from "../shell/page-crumbs";

/** The bench Insights page in miniature: the same runs query and
 * `computeBenchInsights`, fixed to the last 7 days. */
export function InsightsTab({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const runs = useAPIQuery(insightsTopLevelRunsPath(workbenchTenantId), TopLevelRunsSchema);
  const artifacts = useAPIQuery(
    `/api/tenants/${workbenchTenantId}/artifacts`,
    ArtifactListPageSchema,
  );
  const failed = runs.kind === "ready" ? computeBenchInsights(runs.data.data, 7).failures : [];
  const failureEvents = useQueries({
    queries: failed.map((run) =>
      apiQueryOptions(insightsRunEventsPath(workbenchTenantId, run.id), RunEventsSchema),
    ),
  });

  if (runs.kind === "loading") return <Skeleton className="h-32 w-full" />;
  if (runs.kind !== "ready") {
    return (
      <RichEmptyState
        title="Couldn't load insights"
        description="Something went wrong on our side. Try again in a moment."
        {...(runs.kind === "error" ? { actions: [{ label: "Retry", onClick: runs.retry }] } : {})}
      />
    );
  }

  const stats = computeBenchInsights(runs.data.data, 7);
  const rangeStart = stats.days[0]?.date.getTime() ?? 0;
  const saved =
    artifacts.kind === "ready"
      ? formatCount(countSavedArtifacts(artifacts.data.artifacts, rangeStart))
      : "—";

  return (
    <div>
      <section className="drawer-sec">
        <div className="drawer-sec-head">
          <h3>Last 7 days</h3>
        </div>
        <div className="bi-stats">
          {benchInsightTiles(stats, saved).map(([label, value]) => (
            <div key={label} className="bi-stat">
              <div className="bi-stat-v">{value}</div>
              <div className="bi-stat-k">{label}</div>
            </div>
          ))}
        </div>
      </section>
      <section className="drawer-sec">
        <div className="drawer-sec-head">
          <h3>Runs per day</h3>
          <Link to={benchLink(workbenchInsightsPath(workbenchTenantId), workbenchTenantId)}>
            Open insights
          </Link>
        </div>
        <OutcomeChart days={stats.days} weekdayAxis />
      </section>
      {failed.length === 0 ? null : (
        <section className="drawer-sec">
          <div className="drawer-sec-head">
            <h3>Needs a look</h3>
          </div>
          <div className="drawer-list">
            {failed.map((run, i) => {
              const events = failureEvents[i]?.data?.events;
              const why = events === undefined ? null : runFailureMessage(events);
              return (
                <Link
                  key={run.id}
                  to={benchLink(runDetailPath(run.id), workbenchTenantId)}
                  className="drawer-li"
                >
                  <X size={16} aria-hidden="true" />
                  <span className="drawer-li-t">
                    <b>{runDisplayName(run)} failed</b>
                    <span>{why ?? "The run failed."}</span>
                  </span>
                  <span className="drawer-li-m">{formatWhen(run.createdAt)}</span>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
