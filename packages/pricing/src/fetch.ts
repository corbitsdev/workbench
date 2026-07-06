import { type } from "arktype";
import { ModelsDevPayloadSchema, buildPriceCatalog } from "./catalog";
import type { PriceCatalog } from "./catalog";

/**
 * Fetches and parses the models.dev pricing payload into a {@link PriceCatalog},
 * with an in-process TTL cache so the shared hub does not hammer models.dev on
 * every request. There is no redis in the hub, so an in-process memo is the
 * correct cache substrate (see docs/ANALYTICS.md).
 */

export interface FetchPriceCatalogOptions {
  url: string;
  /** How long a fetched catalog stays fresh, in milliseconds. */
  ttlMs: number;
  /**
   * Abort the models.dev fetch after this many milliseconds. A hung connection
   * would otherwise never reject the shared in-flight promise, wedging every
   * pricing request behind it and starving the stale-on-failure path.
   */
  timeoutMs: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

interface CacheEntry {
  catalog: PriceCatalog;
  fetchedAt: number;
}

/**
 * After a refresh fails with a stale entry present, suppress further refresh
 * attempts for this window and keep serving the stale catalog — otherwise every
 * request past the TTL re-hammers a down models.dev.
 */
const FAILURE_BACKOFF_MS = 60_000;

const cache = new Map<string, CacheEntry>();
let inflight = new Map<string, Promise<PriceCatalog>>();
let failedAt = new Map<string, number>();

/** Clears the module-level cache. Test-only. */
export function resetPriceCatalogCache(): void {
  cache.clear();
  inflight = new Map();
  failedAt = new Map();
}

export class PriceCatalogFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceCatalogFetchError";
  }
}

async function fetchAndParse(
  options: FetchPriceCatalogOptions,
): Promise<PriceCatalog> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(options.url, {
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new PriceCatalogFetchError(
      `models.dev pricing fetch failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new PriceCatalogFetchError(
      `models.dev pricing fetch failed: ${response.status} ${response.statusText}`,
    );
  }
  const raw: unknown = await response.json();
  const parsed = ModelsDevPayloadSchema(raw);
  if (parsed instanceof type.errors) {
    throw new PriceCatalogFetchError(
      `models.dev pricing payload failed validation: ${parsed.summary}`,
    );
  }
  const now = (options.now ?? Date.now)();
  return buildPriceCatalog(parsed, options.url, new Date(now).toISOString());
}

/**
 * Returns a cached catalog when still within its TTL, otherwise fetches a fresh
 * one. Concurrent callers during a miss share a single in-flight fetch. On a
 * refresh failure with a stale entry present, the stale catalog is returned
 * (serving slightly old prices beats a hard error on a shared surface) and
 * further refresh attempts are suppressed for {@link FAILURE_BACKOFF_MS} so a
 * down models.dev is not re-hammered on every request; a miss with no cached
 * entry propagates the error.
 */
export async function getPriceCatalog(
  options: FetchPriceCatalogOptions,
): Promise<PriceCatalog> {
  const now = (options.now ?? Date.now)();
  const key = options.url;
  const entry = cache.get(key);
  if (entry !== undefined && now - entry.fetchedAt < options.ttlMs) {
    return entry.catalog;
  }

  const lastFailure = failedAt.get(key);
  if (
    entry !== undefined &&
    lastFailure !== undefined &&
    now - lastFailure < FAILURE_BACKOFF_MS
  ) {
    return entry.catalog;
  }

  const existing = inflight.get(key);
  if (existing !== undefined) return existing;

  const promise = fetchAndParse(options)
    .then((catalog) => {
      cache.set(key, { catalog, fetchedAt: now });
      failedAt.delete(key);
      return catalog;
    })
    .catch((error: unknown) => {
      const stale = cache.get(key);
      if (stale !== undefined) {
        failedAt.set(key, now);
        return stale.catalog;
      }
      throw error;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}
