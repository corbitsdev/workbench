import { RichEmptyState, Skeleton } from "@corbits/react-ui";

import { useAPIQuery } from "../api";
import { insightsTopLevelRunsPath, TopLevelRunsSchema } from "../insights-api";
import {
  approvalRunsInRange,
  computeBenchInsights,
  durationLabel,
  formatCount,
} from "../insights-stats";
import { Link } from "../navigation";
import { workbenchInsightsPath } from "../insights-deeplinks";
import { benchLink } from "../shell/page-crumbs";
import { ApprovalsLine } from "./approvals-insights";
import { OutcomeChart } from "../pages/bench-insights";

/** The bench Insights page in miniature: the same runs query and
 * `computeBenchInsights`, fixed to the last 7 days. */
export function InsightsTab({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const runs = useAPIQuery(insightsTopLevelRunsPath(workbenchTenantId), TopLevelRunsSchema);

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
  const finished = stats.ok + stats.fail;
  const tiles: readonly (readonly [string, string])[] = [
    ["Runs", formatCount(stats.total)],
    ["Succeeded", finished === 0 ? "—" : `${Math.round((stats.ok / finished) * 100)}%`],
    ["Median run", stats.medianMs === null ? "—" : durationLabel(stats.medianMs)],
  ];

  return (
    <div>
      <section className="drawer-sec">
        <div className="drawer-sec-head">
          <h3>Last 7 days</h3>
        </div>
        <div className="bi-stats">
          {tiles.map(([label, value]) => (
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
        </div>
        <OutcomeChart days={stats.days} />
      </section>
      <section className="drawer-sec">
        <div className="drawer-sec-head">
          <h3>Approvals</h3>
        </div>
        <ApprovalsLine
          tenantId={workbenchTenantId}
          runs={approvalRunsInRange(runs.data.data, 7).runs}
        />
      </section>
      <Link
        className="drawer-link"
        to={benchLink(workbenchInsightsPath(workbenchTenantId), workbenchTenantId)}
      >
        Open Insights
      </Link>
    </div>
  );
}
