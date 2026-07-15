import { TimeSeriesChart, type TimeSeries } from "@workbench/ui";

import type { ActivityOverview } from "../../lib/hub-api";
import { fillDailySeries } from "./metrics";
import { SectionLabel } from "./section-label";
import { HudCard } from "./stats";
import type { DateRange } from "./time-range";

/**
 * Overview-tab activity chart (CL-3667). The workflow-runs-by-kind bar chart
 * and the top-actors-by-turns bar chart used to live here too, duplicating the
 * Workflows tab's kind table and the People tab's usage table respectively —
 * both were removed; Overview now only shows the headline trend and links into
 * the owning tab for the breakdown.
 */
export function ChartsSection({
  data,
  range,
}: {
  data: ActivityOverview;
  range: DateRange;
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

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Activity over time</SectionLabel>
      <HudCard label="Activity over time">
        <TimeSeriesChart
          series={activitySeries}
          label="Turns and tool calls per day"
          variant="area"
        />
      </HudCard>
    </div>
  );
}
