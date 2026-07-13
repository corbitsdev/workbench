// The scheduler stores an integer UTC hour (0-23). Users think in their own
// local time, so the picker offers every UTC hour labelled with the local time
// it lands at — a lossless mapping (no rounding of half-hour zones) since the
// stored value is always an exact UTC hour.

export type HourOption = { hourUtc: number; label: string };

/** The local wall-clock label (e.g. "8:00 AM") a given UTC hour fires at. */
export function formatUtcHourLocal(hourUtc: number): string {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
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

const MS_PER_DAY = 86_400_000;

/** Midnight UTC of the given "days since epoch" counter, as stored by the
 * scheduler's `lastFiredDayUtc`. */
export function utcDayToDate(dayUtc: number): Date {
  return new Date(dayUtc * MS_PER_DAY);
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

/** The next UTC instant a schedule fires at, mirroring the scheduler's
 * `shouldFire` rule: it fires the first tick where the UTC hour matches and
 * today's UTC day differs from `lastFiredDayUtc`. */
export function nextFireAt(
  hourUtc: number,
  lastFiredDayUtc: number | null,
  now: Date = new Date(),
): Date {
  const todayUtcDay = Math.floor(now.getTime() / MS_PER_DAY);
  const alreadyFiredToday = lastFiredDayUtc === todayUtcDay;
  // Strictly greater: the target hour itself is still the firing window (the
  // scheduler's `shouldFire` fires on the next tick while `now` sits inside
  // it), so `>=` here would wrongly roll a not-yet-fired current hour to
  // tomorrow.
  const hourAlreadyPassedToday = now.getUTCHours() > hourUtc;
  const targetDay =
    alreadyFiredToday || hourAlreadyPassedToday ? todayUtcDay + 1 : todayUtcDay;
  const target = utcDayToDate(targetDay);
  target.setUTCHours(hourUtc, 0, 0, 0);
  return target;
}

/** A local date/time label for a schedule's next fire, or "Paused" when it is
 * disabled. */
export function formatNextFire(
  hourUtc: number,
  lastFiredDayUtc: number | null,
  enabled: boolean,
  now: Date = new Date(),
): string {
  if (!enabled) return "Paused";
  return nextFireAt(hourUtc, lastFiredDayUtc, now).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
