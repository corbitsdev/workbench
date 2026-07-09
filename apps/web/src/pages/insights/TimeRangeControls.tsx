import type { Preset, DateRange } from "./time-range";
import { PRESETS, selectClass } from "./time-range";

export function TimeRangeControls({
  preset,
  onPresetChange,
  customRange,
  onCustomRangeChange,
}: {
  preset: Preset;
  onPresetChange: (p: Preset) => void;
  customRange: DateRange;
  onCustomRangeChange: (r: DateRange) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {PRESETS.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => onPresetChange(p.value)}
          className={`flex min-h-[40px] items-center rounded-[8px] px-3 py-1.5 text-[12px] font-medium transition-[color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] ${
            preset === p.value
              ? "bg-accent/10 text-accent"
              : "text-text-3 hover:bg-row-hover hover:text-text"
          }`}
        >
          {p.label}
        </button>
      ))}
      {preset === "custom" && (
        <div className="flex items-center gap-1.5" data-testid="custom-range">
          <input
            type="date"
            aria-label="Start date"
            data-testid="custom-start"
            value={customRange.startDate ?? ""}
            onChange={(e) =>
              onCustomRangeChange({ ...customRange, startDate: e.target.value })
            }
            className={selectClass()}
          />
          <span className="text-[12px] text-text-3">to</span>
          <input
            type="date"
            aria-label="End date"
            data-testid="custom-end"
            value={customRange.endDate ?? ""}
            onChange={(e) =>
              onCustomRangeChange({ ...customRange, endDate: e.target.value })
            }
            className={selectClass()}
          />
        </div>
      )}
    </div>
  );
}
