// Whether a workbench row should read as "live", kept apart from the
// activity query itself (see `listActivity` in `./room-messages.ts`) so
// the recency rule is testable without a database.

/** A workbench counts as "live" when its newest message landed within
 * this window of now — no fake presence, just recency. */
export const LIVE_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

export function isRecentlyActive(
  lastActivityAt: string,
  now: Date = new Date(),
): boolean {
  return now.getTime() - Date.parse(lastActivityAt) <= LIVE_ACTIVITY_WINDOW_MS;
}
