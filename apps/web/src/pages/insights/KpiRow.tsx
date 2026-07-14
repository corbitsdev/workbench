import { DashboardSection, StatGrid, StatGridItem } from "@workbench/ui";
import { computeDelta } from "./metrics";
import { formatDollars, formatNumber } from "./stats";
import type { ActivityOverview } from "../../lib/hub-api";
import { DeltaBadge } from "./viz";

export function KpiRow({
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
  const dailyActivity = data.dailySeries.map(
    (d) => d.turnCount + d.toolCallCount,
  );

  return (
    <DashboardSection title="This range" variant="highlighted">
      <StatGrid columns={5}>
        <StatGridItem
          label="Cost"
          value={costTotal !== null ? formatDollars(costTotal) : "—"}
          sub={
            costUnavailable
              ? "pricing unavailable"
              : `${formatNumber(costTokens)} tokens`
          }
          emphasis
        />
        <StatGridItem
          label="Total activity"
          value={formatNumber(activity)}
          sub="turns + tool calls"
          delta={<DeltaBadge delta={computeDelta(activity, prevActivity)} />}
          sparklineValues={dailyActivity.length >= 3 ? dailyActivity : undefined}
          sparklineLabel="Activity trend"
          emphasis
        />
        <StatGridItem
          label="Active actors"
          value={formatNumber(activePeople)}
          sub="people with usage"
          emphasis
        />
        <StatGridItem
          label="Workflow runs"
          value={formatNumber(data.workflowRuns.executionsStartedInRange)}
          sub={`${formatNumber(data.workflowRuns.activeExecutions)} active`}
          emphasis
        />
        <StatGridItem
          label="Artifacts"
          value={formatNumber(data.artifacts.createdInRange)}
          sub={`${formatNumber(data.artifacts.total)} all-time`}
          emphasis
        />
      </StatGrid>
    </DashboardSection>
  );
}