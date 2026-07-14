const MS_PER_DAY = 86_400_000;

/** Midnight UTC of the given "days since epoch" counter, as stored by the
 * scheduler's `lastFiredDayUtc`. */
export function utcDayToDate(dayUtc: number): Date {
  return new Date(dayUtc * MS_PER_DAY);
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