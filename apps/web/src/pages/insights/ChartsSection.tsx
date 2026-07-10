import {
  CategoryBarChart,
  TimeSeriesChart,
  type CategoryDatum,
  type TimeSeries,
} from "@workbench/ui";

import type { ActivityOverview, UsageByPersonRow } from "../../lib/hub-api";
import { fillDailySeries, humanizeKey } from "./metrics";
import { filterPeople, type WorkflowKindRow } from "./overview-derivations";
import { SectionLabel } from "./section-label";
import { CardLabel, formatNumber, HudCard } from "./stats";
import type { DateRange } from "./time-range";

export function ChartsSection({
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
