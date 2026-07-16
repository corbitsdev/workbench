import { toHumanLabel } from "@workbench/ui";
import type { LogStepState } from "../../lib/run-state-adapter";
import {
  buildTraceWaterfallLayout,
  waterfallBarStyle,
  type TraceWaterfallRow,
} from "./trace-waterfall";

const PHASE_BAR_CLASS: Record<LogStepState["phase"], string> = {
  completed: "bg-green/70 border-green/50",
  failed: "bg-red/70 border-red/50",
  "in-flight": "bg-blue/60 border-blue/40",
  "awaiting-signal": "bg-accent/50 border-accent/40",
  "awaiting-timer": "bg-surface-2 border-border",
  cancelled: "bg-surface-2 border-border",
};

function WaterfallRowBar({
  row,
  layout,
  isSelected,
  onSelect,
}: {
  row: TraceWaterfallRow;
  layout: ReturnType<typeof buildTraceWaterfallLayout>;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const bar = waterfallBarStyle(layout, row);
  const phase = row.step.phase;
  const barClass = PHASE_BAR_CLASS[phase];

  return (
    <div
      className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-3 py-1.5"
      data-testid="trace-waterfall-row"
      data-phase={phase}
    >
      <span className="truncate text-[12px] font-medium text-text">
        {row.index + 1}. {toHumanLabel(row.step.stepId)}
      </span>
      <div className="relative h-7 rounded-sm border border-border/60 bg-surface-2">
        {bar !== null ? (
          <button
            type="button"
            data-testid="trace-waterfall-span"
            aria-label={`${toHumanLabel(row.step.stepId)}${row.durationLabel !== null ? `, ${row.durationLabel}` : ""}`}
            aria-pressed={isSelected}
            onClick={onSelect}
            className={`absolute top-1 bottom-1 rounded-sm border ${barClass} ${
              isSelected ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-2" : ""
            } cursor-pointer outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent`}
            style={{
              left: `${bar.leftPercent}%`,
              width: `${bar.widthPercent}%`,
            }}
            title={
              row.durationLabel !== null ? row.durationLabel : undefined
            }
          />
        ) : (
          <div className="flex h-full items-center px-2">
            <span
              data-testid="trace-waterfall-missing-time"
              className="text-[11px] text-text-3"
            >
              {row.missingStart
                ? "No start time"
                : row.missingEnd
                  ? "No end time"
                  : "Timing unavailable"}
            </span>
          </div>
        )}
        {bar !== null && row.durationLabel !== null && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] tabular-nums text-text-3">
            {row.durationLabel}
          </span>
        )}
      </div>
    </div>
  );
}

export function TraceWaterfall({
  steps,
  selectedIndex,
  onSelectStep,
}: {
  steps: LogStepState[];
  selectedIndex: number;
  onSelectStep: (index: number) => void;
}) {
  const layout = buildTraceWaterfallLayout(steps);

  return (
    <div
      data-testid="trace-waterfall"
      className="rounded border border-border bg-surface p-3 shadow-[var(--shadow-card)]"
      role="group"
      aria-label="Step timing overview"
    >
      <p className="mb-2 text-[11px] text-text-3">
        Spans use step start and end timestamps only. Click a bar to focus that
        step in the list.
      </p>
      <div className="flex flex-col gap-0.5">
        {layout.rows.map((row) => (
          <WaterfallRowBar
            key={row.step.stepId}
            row={row}
            layout={layout}
            isSelected={row.index === selectedIndex}
            onSelect={() => onSelectStep(row.index)}
          />
        ))}
      </div>
    </div>
  );
}