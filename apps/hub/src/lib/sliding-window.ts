export interface SlidingWindowLimiter {
  /**
   * Records one spawn attempt for `key` at the current time and reports
   * whether it fits under the budget. Timestamps older than the window are
   * dropped first, so the window slides rather than resetting on a fixed
   * boundary. A rejected attempt is not recorded, so it does not itself
   * count against the budget.
   */
  tryAcquire: (key: string) => boolean;
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

  return { tryAcquire };
}
