import type { ScheduleRecurrence, ScheduleScope } from "@workbench/shared";
import { isRecurrenceAllowedForKind } from "@workbench/shared";
import { formatTimeOnly } from "@workbench/ui";

// A schedule's recurrence is `{ intervalMinutes, anchorMinuteUtc }` (see
// @workbench/shared/scheduled-trigger) — two raw numbers, not a closed set of
// presets. The editor exposes exactly that: "how often" as an amount + unit
// (minutes/hours/days/weeks, decomposed to `intervalMinutes`) and "starting
// at" as a single local time-of-day control (decomposed to
// `anchorMinuteUtc`), the same control regardless of the chosen interval.

export type RecurrenceUnit = "minutes" | "hours" | "days" | "weeks";

const UNIT_MINUTES: Record<RecurrenceUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10080,
};

const UNIT_ORDER: RecurrenceUnit[] = ["minutes", "hours", "days", "weeks"];

const UNIT_LABEL: Record<RecurrenceUnit, { singular: string; plural: string }> =
  {
    minutes: { singular: "minute", plural: "minutes" },
    hours: { singular: "hour", plural: "hours" },
    days: { singular: "day", plural: "days" },
    weeks: { singular: "week", plural: "weeks" },
  };

// The recurrence schema's own bounds (packages/workbench-shared/src/scheduled-trigger.ts)
// are the only genuine floor/ceiling — the scheduler tick runs every 60s
// (apps/hub/src/services/scheduler.ts DEFAULT_TICK_INTERVAL_MS), fine-grained
// enough to catch every 1-minute window, so there is no additional UI floor
// to invent beyond what the backend already enforces.
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 10080;

export function unitMinutes(unit: RecurrenceUnit): number {
  return UNIT_MINUTES[unit];
}

/** Decompose a stored `intervalMinutes` into the largest whole unit + amount
 * that reconstructs it exactly, so reopening a saved schedule shows the same
 * amount/unit it was saved with (e.g. 1440 -> {amount:1, unit:"days"}, not
 * {amount:1440, unit:"minutes"}). */
export function amountUnitFromInterval(intervalMinutes: number): {
  amount: number;
  unit: RecurrenceUnit;
} {
  for (let i = UNIT_ORDER.length - 1; i >= 0; i -= 1) {
    const unit = UNIT_ORDER[i];
    const minutes = UNIT_MINUTES[unit];
    if (intervalMinutes % minutes === 0) {
      return { amount: intervalMinutes / minutes, unit };
    }
  }
  return { amount: intervalMinutes, unit: "minutes" };
}

/** Recompose an amount + unit picked in the editor back into `intervalMinutes`,
 * clamped to the schema's bounds. */
export function intervalFromAmountUnit(
  amount: number,
  unit: RecurrenceUnit,
): number {
  const raw = Math.round(amount) * UNIT_MINUTES[unit];
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, raw));
}

/** Whether a workflow kind's per-kind rule (`isRecurrenceAllowedForKind`)
 * accepts anything other than the fixed daily cadence — used to lock the
 * "how often" control down to "Once a day" for kinds like heartbeat, whose
 * fire-time enrichment requires exactly a daily interval. Anchor is unaffected
 * by kind, so only the interval side of the control is ever locked.
 *
 * Probes with one arbitrary non-daily value (hourly) rather than enumerating
 * every possible interval, so this assumes any kind restriction
 * `isRecurrenceAllowedForKind` expresses is literally "must be daily" — true
 * for every kind today, but a future kind with a different (e.g. "must be at
 * least weekly") restriction would be silently mislabeled as daily-only by
 * this probe. Revisit if `isRecurrenceAllowedForKind` ever grows a second
 * kind of restriction. */
export function onlyDailyAllowedForKind(kind: string): boolean {
  return !isRecurrenceAllowedForKind(kind, {
    intervalMinutes: 60,
    anchorMinuteUtc: 0,
  });
}

/** The local wall-clock label (e.g. "8:00 AM") a given UTC minute-of-day fires at. */
export function formatAnchorLocal(anchorMinuteUtc: number): string {
  const d = new Date();
  d.setUTCHours(0, anchorMinuteUtc, 0, 0);
  return formatTimeOnly(d);
}

/** The local wall-clock label (e.g. "8:00 AM") a given UTC hour fires at.
 * Kept for the heartbeat-attachment display (BriefWorkflowAttachments), which
 * only ever shows heartbeat's fixed daily-at-hour cadence. */
export function formatUtcHourLocal(hourUtc: number): string {
  return formatAnchorLocal(hourUtc * 60);
}

/** The `{hour, minute}` a local `<input type="time">` control should show for
 * a stored `anchorMinuteUtc`. */
export function localTimeFromAnchor(anchorMinuteUtc: number): {
  hour: number;
  minute: number;
} {
  const d = new Date();
  d.setUTCHours(0, anchorMinuteUtc, 0, 0);
  return { hour: d.getHours(), minute: d.getMinutes() };
}

/** A local `HH:MM` (24h) string for `<input type="time">`, derived from a
 * stored `anchorMinuteUtc`. */
export function anchorToLocalTimeInputValue(anchorMinuteUtc: number): string {
  const { hour, minute } = localTimeFromAnchor(anchorMinuteUtc);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The `anchorMinuteUtc` (0-1439) a local `HH:MM` `<input type="time">` value
 * maps to. */
export function localTimeInputValueToAnchor(value: string): number {
  const [hourStr, minuteStr] = value.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Product labels for schedule scope (CL-4111). Keep in one place. */
export function scheduleScopeLabel(scope: ScheduleScope): string {
  return scope === "tenant" ? "Everyone" : "Just me";
}

function intervalLabel(amount: number, unit: RecurrenceUnit): string {
  if (amount === 1) {
    if (unit === "days") return "Once a day";
    if (unit === "weeks") return "Once a week";
    return `Every ${UNIT_LABEL[unit].singular}`;
  }
  return `Every ${amount} ${UNIT_LABEL[unit].plural}`;
}

/** Human label for a stored recurrence, combining the "how often" and
 * "starting at" halves — used everywhere a schedule's cadence is displayed
 * read-only, and correctly renders sub-hourly cadences (CL-4278). */
export function formatRecurrence(recurrence: ScheduleRecurrence): string {
  const { amount, unit } = amountUnitFromInterval(recurrence.intervalMinutes);
  const anchorLabel = formatAnchorLocal(recurrence.anchorMinuteUtc);
  return `${intervalLabel(amount, unit)}, starting at ${anchorLabel}`;
}

/** The default recurrence a fresh picker opens with: once a day, at the
 * current local hour. */
export function defaultRecurrence(): ScheduleRecurrence {
  const d = new Date();
  return {
    intervalMinutes: 1440,
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
