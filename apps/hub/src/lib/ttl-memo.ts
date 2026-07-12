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
    now?: () => number;
  }): Promise<T>;
  /** Test-only: clears every cached and in-flight entry. */
  reset(): void;
};

// Generic short-TTL in-process memo: a keyed value+storedAt map with
// injectable-clock expiry and in-flight de-dup so a burst of concurrent
// callers for the same key collapses onto one `resolve()`. In-process only,
// no redis — each caller owns one instance (module-level singleton) keyed by
// whatever discriminator its domain needs.
export function createTtlMemo<T>(): TtlMemo<T> {
  type Entry = { value: T; storedAt: number };

  const cache = new Map<string, Entry>();
  let inflight = new Map<string, Promise<T>>();

  return {
    async get({ key, resolve, ttlMs, now }) {
      const clock = now ?? Date.now;

      const cached = cache.get(key);
      if (cached !== undefined && clock() - cached.storedAt < ttlMs) {
        return cached.value;
      }

      const existing = inflight.get(key);
      if (existing !== undefined) return existing;

      const promise = resolve()
        .then((value) => {
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
