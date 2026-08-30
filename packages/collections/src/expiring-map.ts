// A TTL-eviction map for process-lifetime state whose only invariant is
// "how recently was this key touched" — a rate limiter, a dedupe guard,
// anything where an entry older than its own TTL is worthless and safe
// to forget (CL-7233). `get` drops an expired entry lazily on read;
// `set` opportunistically sweeps every expired entry once per TTL
// window, amortizing the cost of a full pass rather than checking every
// key on every call. There is no background timer: nothing to `unref`,
// nothing to leak if the map itself is dropped, and a test can drive it
// entirely with a fake clock.
export type ExpiringMap<K, V> = {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  /** The count of live entries as of this read — always sweeps first,
   * since a stale expired-but-unswept count would defeat the point of
   * exposing size at all (a caller reading it as a memory/cardinality
   * signal). */
  readonly size: number;
};

type Entry<V> = { value: V; expiresAt: number };

export function createExpiringMap<K, V>(options: {
  readonly ttlMs: number;
  readonly now?: () => number;
}): ExpiringMap<K, V> {
  const now = options.now ?? Date.now;
  const entries = new Map<K, Entry<V>>();
  let lastSweptAt = now();

  function isExpired(entry: Entry<V>, at: number): boolean {
    return at >= entry.expiresAt;
  }

  function sweep(at: number): void {
    lastSweptAt = at;
    for (const [key, entry] of entries) {
      if (isExpired(entry, at)) entries.delete(key);
    }
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      const at = now();
      if (isExpired(entry, at)) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      const at = now();
      if (at - lastSweptAt >= options.ttlMs) sweep(at);
      entries.set(key, { value, expiresAt: at + options.ttlMs });
    },
    delete(key) {
      return entries.delete(key);
    },
    get size() {
      sweep(now());
      return entries.size;
    },
  };
}
