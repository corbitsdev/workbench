import type { Context, MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  /** Length of the fixed window in milliseconds. */
  windowMs: number;
  /** Maximum number of requests allowed per key within a window. */
  max: number;
  /**
   * Derive the bucket key from the request. Return `null` to skip limiting for
   * this request (no trusted client identity). Defaults to the trusted client IP.
   */
  keyForRequest?: (c: Context) => string | null;
  /** Clock injection point for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Hard cap on tracked keys. When exceeded, expired buckets are swept; if the
   * map is still full afterward, new keys are admitted without tracking (fail
   * open) rather than letting the map grow without bound. Defaults to 100_000.
   */
  maxTrackedKeys?: number;
}

/**
 * Trusted client IP. `x-forwarded-for` is "client, proxy1, proxy2, …": each hop
 * appends the address it received the connection from, so the entry appended by
 * our own trusted ingress is the LAST one. The leftmost entry is client-supplied
 * and therefore spoofable — keying on it would let an attacker get a fresh
 * bucket per request and plant unbounded map entries. Using the last hop assumes
 * exactly one trusted proxy in front of the hub (the deployment topology).
 *
 * Returns `null` when there is no trusted forwarded hop. The caller then skips
 * limiting for that request (fail open) rather than collapsing every header-less
 * request onto one shared bucket — a shared bucket would let a few direct
 * connections lock out all sign-ins (global DoS). `x-real-ip` is deliberately
 * NOT used as a fallback: it is client-spoofable, so trusting it would let an
 * attacker both bypass the limit and bloat the bucket map.
 */
function defaultKeyForRequest(c: Context): string | null {
  const forwardedFor = c.req.header("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor.split(",");
    const last = hops[hops.length - 1];
    if (last && last.trim().length > 0) return last.trim();
  }
  return null;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window in-memory rate limiter middleware. Single-process only: it
 * defends a single hub instance against brute-force bursts and is not a
 * substitute for an infra-level limiter across replicas. Returns 429 with a
 * `Retry-After` header once a key exceeds `max` within `windowMs`.
 */
export function createRateLimiter(
  options: RateLimitOptions,
): MiddlewareHandler {
  const { windowMs, max } = options;
  const keyForRequest = options.keyForRequest ?? defaultKeyForRequest;
  const now = options.now ?? Date.now;
  const maxTrackedKeys = options.maxTrackedKeys ?? 100_000;
  const buckets = new Map<string, Bucket>();

  function sweepExpired(current: number): void {
    for (const [key, bucket] of buckets) {
      if (current >= bucket.resetAt) buckets.delete(key);
    }
  }

  return async (c, next) => {
    const key = keyForRequest(c);
    // No trusted client identity → do not limit (and do not track), rather than
    // funnelling every such request into one shared bucket.
    if (key === null) return next();
    const current = now();
    const bucket = buckets.get(key);

    if (!bucket || current >= bucket.resetAt) {
      // Bound memory: sweep expired buckets before admitting a new key, and if
      // the map is still at capacity, fail open rather than grow unbounded.
      if (!bucket && buckets.size >= maxTrackedKeys) {
        sweepExpired(current);
        if (buckets.size >= maxTrackedKeys) return next();
      }
      buckets.set(key, { count: 1, resetAt: current + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.resetAt - current) / 1000),
      );
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json({ error: "Too many requests" }, 429);
    }

    bucket.count += 1;
    return next();
  };
}
