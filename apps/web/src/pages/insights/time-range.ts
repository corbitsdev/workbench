export type Preset = "24h" | "7d" | "30d" | "90d" | "all" | "custom";

export const PRESETS: { label: string; value: Preset }[] = [
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
  { label: "All time", value: "all" },
  { label: "Custom", value: "custom" },
];

export type DateRange = { startDate?: string; endDate?: string };

export const PRESET_DAYS: Record<Exclude<Preset, "all" | "custom">, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function resolveRange(preset: Preset, custom: DateRange): DateRange {
  if (preset === "all") return {};
  if (preset === "custom") {
    if (custom.startDate === undefined || custom.startDate === "") return {};
    return {
      startDate: custom.startDate,
      ...(custom.endDate ? { endDate: custom.endDate } : {}),
    };
  }
  return { startDate: daysAgoISO(PRESET_DAYS[preset]) };
}

export function selectClass(): string {
  return "min-h-[40px] rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-text-2 outline-none focus-visible:ring-1 focus-visible:ring-accent";
}
