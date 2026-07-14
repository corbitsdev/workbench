import { AppPageChromeRow, Button } from "@workbench/ui";
import { Download } from "lucide-react";

import type { ActivityExportBucket } from "../../lib/hub-api";
import { TimeRangeControls } from "./TimeRangeControls";
import type { DateRange, Preset } from "./time-range";
import { selectClass } from "./time-range";

export function InsightsPageHeader({
  tenantName,
  preset,
  onPresetChange,
  customRange,
  onCustomRangeChange,
  exportBucket,
  onExportBucketChange,
  canExport,
  onExportCsv,
}: {
  tenantName: string | undefined;
  preset: Preset;
  onPresetChange: (p: Preset) => void;
  customRange: DateRange;
  onCustomRangeChange: (r: DateRange) => void;
  exportBucket: ActivityExportBucket;
  onExportBucketChange: (bucket: ActivityExportBucket) => void;
  canExport: boolean;
  onExportCsv: () => void;
}) {
  return (
    <AppPageChromeRow
      title="Data & Insights"
      titleSize="sm"
      subtitle={tenantName}
      className="flex-wrap"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <TimeRangeControls
          preset={preset}
          onPresetChange={onPresetChange}
          customRange={customRange}
          onCustomRangeChange={onCustomRangeChange}
        />
        <select
          aria-label="Export bucket"
          data-testid="export-bucket"
          value={exportBucket}
          onChange={(e) =>
            onExportBucketChange(e.target.value as ActivityExportBucket)
          }
          className={selectClass()}
        >
          <option value="day">Daily</option>
          <option value="week">Weekly</option>
          <option value="month">Monthly</option>
        </select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onExportCsv}
          disabled={!canExport}
          title={
            canExport
              ? "Download metrics and usage breakdowns as CSV"
              : "No metrics to export for this range"
          }
          className="flex min-h-[40px] items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12px] font-medium text-text-3 transition-[color,background-color] duration-150 hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-3"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>
    </AppPageChromeRow>
  );
}
