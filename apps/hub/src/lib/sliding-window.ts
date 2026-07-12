export interface SlidingWindowLimiter {
  /**
   * Records one spawn attempt for `key` at the current time and reports
   * whether it fits under the budget. Timestamps older than the window are
   * dropped first, so the window slides rather than resetting on a fixed
   * boundary. A rejected attempt is not recorded, so it does not itself
   * count against the budget.
   */
  tryAcquire: (key: string) => boolean;
  refund: (key: string) => void;
}

/**
 * In-memory sliding-window spawn budget, keyed per caller-supplied key
 * (e.g. tenantId). Shared by any hub-side gap that needs to cap a rate of
 * spawns/starts over time rather than just bound a queue or a single
 * in-flight count — a bounded queue or single-flight gate still allows
 * unbounded units *over time*, which this closes.
 */
export function slidingWindowLimiter(
  maxPerWindow: number,
  windowMs: number,
  clock: () => number = Date.now,
): SlidingWindowLimiter {
  const timestamps = new Map<string, number[]>();

  function tryAcquire(key: string): boolean {
    const now = clock();
    const cutoff = now - windowMs;
    const existing = timestamps.get(key) ?? [];
    const inWindow = existing.filter((ts) => ts > cutoff);
    if (inWindow.length >= maxPerWindow) {
      timestamps.set(key, inWindow);
      return false;
    }
    inWindow.push(now);
    timestamps.set(key, inWindow);
    return true;
  }

  // Returns the most recently acquired slot for a key — used when the guarded
  // action fails downstream, so a transient failure does not lock the caller
  // out for the rest of the window.
  function refund(key: string): void {
    const existing = timestamps.get(key);
    if (!existing || existing.length === 0) return;
    existing.pop();
    timestamps.set(key, existing);
  }

  return { tryAcquire, refund };
}
