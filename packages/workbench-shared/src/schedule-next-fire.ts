const MS_PER_MINUTE = 60_000;

/** The next UTC instant a schedule fires at, mirroring the scheduler's
 * `shouldFire` catch-up rule (see apps/hub/src/services/scheduler.ts): a
 * schedule fires whenever the current recurrence window index is greater
 * than `lastFiredWindowIndex`. So the next fire is the boundary of the
 * CURRENT window (which may already be <= `now` — imminent/overdue, catch-up
 * pending) when that window hasn't fired yet, or the boundary of the next
 * window when it has. `lastFiredWindowIndex` is never null in practice —
 * every write path (creation, retargeting, migration backfill) stamps a real
 * window index, the same structural guarantee `scheduler.ts` relies on. */
export function nextFireAt(
  intervalMinutes: number,
  anchorMinuteUtc: number,
  lastFiredWindowIndex: number,
  now: Date = new Date(),
): Date {
  const nowMinuteUtc = Math.floor(now.getTime() / MS_PER_MINUTE);
  const currentWindowIndex = Math.floor(
    (nowMinuteUtc - anchorMinuteUtc) / intervalMinutes,
  );
  const targetWindowIndex =
    currentWindowIndex > lastFiredWindowIndex
      ? currentWindowIndex
      : lastFiredWindowIndex + 1;
  const targetMinuteUtc = anchorMinuteUtc + targetWindowIndex * intervalMinutes;
  return new Date(targetMinuteUtc * MS_PER_MINUTE);
}
