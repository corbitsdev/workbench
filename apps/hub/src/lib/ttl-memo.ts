export type TtlMemo<T> = {
  /**
   * Returns the cached value for `key` if it is younger than `ttlMs`;
   * otherwise calls `resolve()` (deduping concurrent callers for the same key
   * onto one in-flight promise) and caches the result.
   */
  get(args: {
    key: string;
    resolve: () => Promise<T>;
    ttlMs: number;
    now?: (() => number) | undefined;
  }): Promise<T>;
  /** Test-only: clears every cached and in-flight entry. */
  reset(): void;
};

export type TtlMemoOptions = {
  /**
   * Caps the number of resident entries. When set and an insert would exceed
   * the cap, the stalest entry (oldest `storedAt`) is evicted first — a plain
   * scan, not an LRU list, since these maps stay small (low hundreds of
   * entries at most). A key with an in-flight fetch is never evicted, so a
   * slow resolve can't be discarded out from under its own callers.
   */
  maxEntries?: number;
};

// Generic short-TTL in-process memo: a keyed value+storedAt map with
// injectable-clock expiry and in-flight de-dup so a burst of concurrent
// callers for the same key collapses onto one `resolve()`. In-process only,
// no redis — each caller owns one instance (module-level singleton) keyed by
// whatever discriminator its domain needs. `ttlMs: 0` is the cache-off
// escape hatch: a freshly stored entry is never younger than a 0ms TTL, so
// every call re-resolves (concurrent callers for the same key still collapse
// onto one in-flight promise).
export function createTtlMemo<T>(options: TtlMemoOptions = {}): TtlMemo<T> {
  type Entry = { value: T; storedAt: number };

  const cache = new Map<string, Entry>();
  let inflight = new Map<string, Promise<T>>();

  function evictStalestIfOverCap(insertingKey: string): void {
    const maxEntries = options.maxEntries;
    if (maxEntries === undefined) return;
    if (cache.has(insertingKey)) return;
    if (cache.size < maxEntries) return;

    let stalestKey: string | undefined;
    let stalestStoredAt = Infinity;
    for (const [candidateKey, entry] of cache) {
      if (inflight.has(candidateKey)) continue;
      if (entry.storedAt < stalestStoredAt) {
        stalestStoredAt = entry.storedAt;
        stalestKey = candidateKey;
      }
    }
    if (stalestKey !== undefined) cache.delete(stalestKey);
  }

  return {
    async get({ key, resolve, ttlMs, now }) {
      const clock = now ?? Date.now;

      const cached = cache.get(key);
      if (cached !== undefined) {
        if (clock() - cached.storedAt < ttlMs) return cached.value;
        cache.delete(key);
      }

      const existing = inflight.get(key);
      if (existing !== undefined) return existing;

      const promise = resolve()
        .then((value) => {
          evictStalestIfOverCap(key);
          cache.set(key, { value, storedAt: clock() });
          return value;
        })
        .finally(() => {
          inflight.delete(key);
        });

      inflight.set(key, promise);
      return promise;
    },
    reset() {
      cache.clear();
      inflight = new Map();
    },
  };
}
