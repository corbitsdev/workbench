import {
  DashboardSection,
  PulsingRing,
  StatGrid,
  StatGridItem,
} from "@workbench/ui";
import { computeDelta } from "./metrics";
import { formatDollars, formatNumber } from "./stats";
import type { ActivityOverview } from "../../lib/hub-api";
import { DeltaBadge } from "./viz";
import type { InsightsTabId } from "./InsightsTabs";

function KpiTile({
  tab,
  label,
  onNavigate,
  children,
}: {
  tab: InsightsTabId;
  label: string;
  onNavigate: (tab: InsightsTabId) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(tab)}
      className="rounded-[10px] text-left outline-none transition-[transform] focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.98]"
      aria-label={`View ${label} on the ${tab} tab`}
    >
      {children}
    </button>
  );
}

/**
 * This-range summary tiles (CL-3667): each tile deep-links into the tab that
 * owns the full breakdown instead of repeating it inline — Overview shows the
 * headline number once, the detail lives on exactly one tab.
 */
export function KpiRow({
  data,
  activePeople,
  costTotal,
  costTokens,
  costUnavailable,
  onNavigateTab,
}: {
  data: ActivityOverview;
  activePeople: number;
  /** Total dollar cost from the resolved rate catalog, or null while unresolved. */
  costTotal: number | null;
  costTokens: number;
  /** True once pricing has been checked and no rate could be resolved for any usage. */
  costUnavailable: boolean;
  onNavigateTab: (tab: InsightsTabId) => void;
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
        <KpiTile tab="usage-cost" label="cost" onNavigate={onNavigateTab}>
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
        </KpiTile>
        <KpiTile
          tab="usage-cost"
          label="total activity"
          onNavigate={onNavigateTab}
        >
          <StatGridItem
            label="Total activity"
            value={formatNumber(activity)}
            sub="chats + tool calls"
            delta={<DeltaBadge delta={computeDelta(activity, prevActivity)} />}
            sparklineValues={
              dailyActivity.length >= 3 ? dailyActivity : undefined
            }
            sparklineLabel="Activity trend"
            emphasis
          />
        </KpiTile>
        <KpiTile tab="people" label="active actors" onNavigate={onNavigateTab}>
          <StatGridItem
            label="Active actors"
            value={formatNumber(activePeople)}
            sub="people with usage"
            emphasis
          />
        </KpiTile>
        <KpiTile
          tab="workflows"
          label="workflow runs"
          onNavigate={onNavigateTab}
        >
          <StatGridItem
            label="Workflow runs"
            value={formatNumber(data.workflowRuns.executionsStartedInRange)}
            sub={
              <span className="inline-flex items-center gap-1.5">
                {data.workflowRuns.activeExecutions > 0 && (
                  <span
                    className="relative inline-flex h-1.5 w-1.5 shrink-0"
                    data-testid="kpi-active-pulse"
                  >
                    <PulsingRing colorClassName="bg-blue/60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue" />
                  </span>
                )}
                {`${formatNumber(data.workflowRuns.activeExecutions)} active`}
              </span>
            }
            emphasis
          />
        </KpiTile>
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
