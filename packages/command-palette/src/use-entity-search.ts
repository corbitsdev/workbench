import { useEffect, useRef, useState } from "react";

import { searchEntities } from "./entity-search";
import type { EntitySearchResult, SearchableEntity } from "./entity-search";

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_DEBOUNCE_MS = 200;

/** A named fetcher the hook calls once per search. The `category` label
 * flows through to every result so the consumer can group and route them. */
export type EntitySourceFetcher = {
  readonly category: string;
  readonly fetch: () => Promise<readonly SearchableEntity[]>;
};

export type UseEntitySearchOptions = {
  readonly query: string;
  /** Skip fetching entirely while the palette is closed. */
  readonly enabled: boolean;
  readonly pageSize?: number;
  readonly debounceMs?: number;
  readonly sources: readonly EntitySourceFetcher[];
};

export type UseEntitySearchResult = {
  readonly results: readonly EntitySearchResult[];
  readonly loading: boolean;
  readonly error: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
};

/**
 * Debounces a typed query, fetches every source once per search (cached
 * across pages of the same search), and matches/paginates them via
 * `searchEntities`. Debouncing lives here rather than in the app shell
 * because it is inseparable from the pagination it resets: a keystroke
 * that arrives mid-debounce must restart the timer *and* the offset
 * together, or a stale page from the previous query would leak into the
 * new one.
 *
 * `loading` is derived, not just set in an effect: the moment a keystroke
 * makes `query` outrun the debounce-committed `debouncedQuery`, the hook is
 * `pending`, and that is visible on the very render the keystroke caused —
 * no waiting for a passive effect to flush. It stays true through the fetch
 * (`fetching`) and only drops once that query's results are ready.
 *
 * All sources are fetched in parallel via `Promise.all`; a failure in any
 * one surfaces as `error: true` rather than a partial result set.
 */
export function useEntitySearch({
  query,
  enabled,
  pageSize = DEFAULT_PAGE_SIZE,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  sources,
}: UseEntitySearchOptions): UseEntitySearchResult {
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [fetched, setFetched] = useState<ReadonlyMap<
    string,
    readonly SearchableEntity[]
  > | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(false);
  const fetchToken = useRef(0);
  // Hold the latest fetchers without making the fetch effect depend on
  // their identity — callers (and tests) are free to hand in fresh arrow
  // functions each render without restarting the search or looping.
  const fetchersRef = useRef(sources);
  fetchersRef.current = sources;

  // True the instant a keystroke outruns the debounce and stays true until
  // that query's fetch resolves — derived here so the spinner shows on the
  // render the keystroke caused, before any passive effect runs.
  const pending =
    enabled && query.trim().length > 0 && debouncedQuery !== query;

  useEffect(() => {
    setOffset(0);
    if (!enabled || query.trim().length === 0) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(query), debounceMs);
    return () => clearTimeout(timer);
  }, [query, enabled, debounceMs]);

  useEffect(() => {
    if (debouncedQuery.trim().length === 0) {
      setFetched(null);
      setFetching(false);
      setError(false);
      return;
    }
    const token = ++fetchToken.current;
    setFetching(true);
    setError(false);
    const current = fetchersRef.current;
    void Promise.all(current.map((source) => source.fetch()))
      .then((results) => {
        if (token !== fetchToken.current) return;
        const map = new Map<string, readonly SearchableEntity[]>();
        for (let i = 0; i < current.length; i++) {
          const source = current[i];
          if (!source) continue;
          map.set(source.category, results[i] ?? []);
        }
        setFetched(map);
        setFetching(false);
      })
      .catch(() => {
        if (token !== fetchToken.current) return;
        setError(true);
        setFetching(false);
      });
  }, [debouncedQuery]);

  const loading = pending || fetching;

  if (fetched === null || debouncedQuery.trim().length === 0) {
    // Nothing is fetched yet, so there is no next page to load — a no-op
    // rather than a call that pretends otherwise.
    return {
      results: [],
      loading,
      error,
      hasMore: false,
      loadMore: () => {},
    };
  }

  const resolvedSources = fetchersRef.current.map((source) => ({
    category: source.category,
    entities: fetched.get(source.category) ?? [],
  }));

  const page = searchEntities({
    query: debouncedQuery,
    sources: resolvedSources,
    pageSize: offset + pageSize,
    offset: 0,
  });

  return {
    results: page.results,
    loading,
    error,
    hasMore: page.hasMore,
    loadMore: () => setOffset((current) => current + pageSize),
  };
}
