import type { ActivityOverview } from "../../lib/hub-api";
import {
  computeDelta,
  fillDailySeries,
  sumInferenceTokenClasses,
} from "./metrics";
import { formatNumber } from "./stats";
import { HudCard, TrendCard } from "./stats";
import { Heatmap } from "./viz";
import { SectionLabel } from "./section-label";

export function TrendsSection({
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
  const tokenValues = series.map((d) => sumInferenceTokenClasses(d));
  const heatDays = series.map((d) => ({ date: d.date, value: d.turnCount }));

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Activity trends</SectionLabel>
      <div className="grid gap-4 lg:grid-cols-3">
        <TrendCard
          label="Chats / day"
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
          total={formatNumber(sumInferenceTokenClasses(summary))}
          values={tokenValues}
          delta={
            tokenCaveat === null
              ? computeDelta(
                  sumInferenceTokenClasses(summary),
                  prev ? sumInferenceTokenClasses(prev) : null,
                )
              : undefined
          }
        />
      </div>
      <HudCard label="Chats per day">
        <Heatmap days={heatDays} label="Chats per day heatmap" />
      </HudCard>
    </div>
  );
}
