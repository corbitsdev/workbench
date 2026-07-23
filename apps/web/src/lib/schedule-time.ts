import type { ScheduleRecurrence, ScheduleScope } from "@workbench/shared";
import { formatTimeOnly } from "@workbench/ui";

// A schedule's recurrence is `{ intervalMinutes, anchorMinuteUtc }` (see
// @workbench/shared/scheduled-trigger). The picker offers a small closed set
// of cadences — daily at a chosen local hour, or a sub-daily interval — each
// encoded as a string key so a single <select> can drive both shapes.

export type RecurrenceOption = { key: string; label: string };

const DAILY_INTERVAL_MINUTES = 1440;
const SUB_DAILY_INTERVALS = [5, 10, 15, 30, 60] as const;

function subDailyKey(intervalMinutes: number): string {
  return `interval:${intervalMinutes}`;
}

function dailyKey(hourUtc: number): string {
  return `daily:${hourUtc}`;
}

function subDailyLabel(intervalMinutes: number): string {
  return intervalMinutes === 60
    ? "Every hour"
    : `Every ${intervalMinutes} minutes`;
}

/** Product labels for schedule scope (CL-4111). Keep in one place. */
export function scheduleScopeLabel(scope: ScheduleScope): string {
  return scope === "tenant" ? "Everyone" : "Just for me";
}

/** The local wall-clock label (e.g. "8:00 AM") a given UTC hour fires at. */
export function formatUtcHourLocal(hourUtc: number): string {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  return formatTimeOnly(d);
}

/** Minutes past local midnight a given UTC hour lands at — used only to order
 * the picker by the user's clock rather than by UTC. */
function localMinutesOfDay(hourUtc: number): number {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.getHours() * 60 + d.getMinutes();
}

/** Every selectable recurrence, ordered sub-daily-first (fastest to slowest)
 * then daily options by local clock. The value the caller stores is the
 * `ScheduleRecurrence` returned by `decodeRecurrenceKey`, not the key itself —
 * the key only drives the single-select control. */
export function recurrenceOptions(): RecurrenceOption[] {
  const subDaily = SUB_DAILY_INTERVALS.map((intervalMinutes) => ({
    key: subDailyKey(intervalMinutes),
    label: subDailyLabel(intervalMinutes),
  }));
  const daily = Array.from({ length: 24 }, (_, hourUtc) => hourUtc)
    .sort((a, b) => localMinutesOfDay(a) - localMinutesOfDay(b))
    .map((hourUtc) => ({
      key: dailyKey(hourUtc),
      label: `Daily at ${formatUtcHourLocal(hourUtc)}`,
    }));
  return [...subDaily, ...daily];
}

/** The recurrence key that round-trips a stored `ScheduleRecurrence` back to
 * a picker selection. A recurrence the picker has no preset for (e.g. one set
 * via the API directly) falls back to its nearest daily-hour label so the UI
 * never renders a blank/invalid selection — it still shows real data derived
 * from what's stored, never a placeholder. */
export function encodeRecurrence(recurrence: ScheduleRecurrence): string {
  if (recurrence.intervalMinutes === DAILY_INTERVAL_MINUTES) {
    return dailyKey(Math.floor(recurrence.anchorMinuteUtc / 60));
  }
  const preset = SUB_DAILY_INTERVALS.find(
    (i) => i === recurrence.intervalMinutes,
  );
  if (preset !== undefined) return subDailyKey(preset);
  return dailyKey(Math.floor(recurrence.anchorMinuteUtc / 60));
}

export function decodeRecurrenceKey(key: string): ScheduleRecurrence {
  const [kind, value] = key.split(":");
  const n = Number(value);
  if (kind === "interval") {
    return { intervalMinutes: n, anchorMinuteUtc: 0 };
  }
  return { intervalMinutes: DAILY_INTERVAL_MINUTES, anchorMinuteUtc: n * 60 };
}

/** Human label for a stored recurrence, in the user's local clock for the
 * daily case. Used everywhere a schedule's cadence is displayed read-only. */
export function formatRecurrence(recurrence: ScheduleRecurrence): string {
  if (recurrence.intervalMinutes === DAILY_INTERVAL_MINUTES) {
    return `Daily at ${formatUtcHourLocal(Math.floor(recurrence.anchorMinuteUtc / 60))}`;
  }
  return subDailyLabel(recurrence.intervalMinutes);
}

/** The default recurrence a fresh picker opens with. */
export function defaultRecurrence(): ScheduleRecurrence {
  const d = new Date();
  return {
    intervalMinutes: DAILY_INTERVAL_MINUTES,
    anchorMinuteUtc: d.getUTCHours() * 60,
  };
}

/** A local date/time label for the most recent fire, or "Not yet fired". */
export function formatLastFiredAt(lastFiredAtIso: string | null): string {
  if (lastFiredAtIso === null) return "Not yet fired";
  return new Date(lastFiredAtIso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A local date/time label for the hub-computed next fire, or "Paused". */
export function formatNextFire(
  nextFireAtIso: string | null,
  enabled: boolean,
): string {
  if (!enabled || nextFireAtIso === null) return "Paused";
  return new Date(nextFireAtIso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
