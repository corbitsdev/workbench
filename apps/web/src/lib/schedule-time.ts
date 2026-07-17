import { utcDayToDate } from "@workbench/shared";
import { formatTimeOnly } from "@workbench/ui";

// The scheduler stores an integer UTC hour (0-23). Users think in their own
// local time, so the picker offers every UTC hour labelled with the local time
// it lands at — a lossless mapping (no rounding of half-hour zones) since the
// stored value is always an exact UTC hour.

export type HourOption = { hourUtc: number; label: string };

/** The local wall-clock label (e.g. "8:00 AM") a given UTC hour fires at. */
export function formatUtcHourLocal(hourUtc: number): string {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  return formatTimeOnly(d);
}

/** Minutes past local midnight a given UTC hour lands at — used only to order
 * the picker by the user's clock rather than by UTC. */
export function localMinutesOfDay(hourUtc: number): number {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.getHours() * 60 + d.getMinutes();
}

/** All 24 UTC hours, labelled in local time and ordered by the local clock. */
export function utcHourOptions(): HourOption[] {
  return Array.from({ length: 24 }, (_, hourUtc) => ({
    hourUtc,
    label: formatUtcHourLocal(hourUtc),
  })).sort(
    (a, b) => localMinutesOfDay(a.hourUtc) - localMinutesOfDay(b.hourUtc),
  );
}

/** The UTC hour a given local hour-of-day maps to today (for picker defaults). */
export function localHourToUtc(localHour: number): number {
  const d = new Date();
  d.setHours(localHour, 0, 0, 0);
  return d.getUTCHours();
}

/** A short local-date label for the day a schedule last fired, or `null` when
 * it has never fired. */
export function formatLastFired(lastFiredDayUtc: number | null): string {
  if (lastFiredDayUtc === null) return "Not yet fired";
  return utcDayToDate(lastFiredDayUtc).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
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
