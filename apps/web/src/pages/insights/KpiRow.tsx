import { SectionLabel } from "./section-label";
import { computeDelta } from "./metrics";
import { formatDollars, formatNumber, Stat } from "./stats";
import type { ActivityOverview } from "../../lib/hub-api";

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
          value={formatNumber(data.workflowRuns.executionsStartedInRange)}
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
