/**
 * Time-based auto-collapse for settled Myra trace blocks (CL-3559).
 *
 * Product rule: a turn is "aged" when its `createdAt` is older than
 * {@link MYRA_AGED_HISTORY_MS} (24 hours) relative to the viewer's clock.
 * Scroll-based collapse was considered but rejected: message timestamps are
 * already on every bubble, reload-stable, and do not depend on viewport layout.
 */

/** Default age threshold — 24 hours. */
export const MYRA_AGED_HISTORY_MS = 24 * 60 * 60 * 1000;

/**
 * True when an ISO `createdAt` is older than {@link MYRA_AGED_HISTORY_MS}
 * before `nowMs` (defaults to `Date.now()`).
 */
export function isMyraHistoryAged(
  createdAt: string,
  nowMs: number = Date.now(),
): boolean {
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return false;
  return nowMs - at >= MYRA_AGED_HISTORY_MS;
}