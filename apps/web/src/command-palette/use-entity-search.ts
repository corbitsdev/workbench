import { useQuery } from "@tanstack/react-query";
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

// Debouncing lives here, not the app shell, because it's inseparable from
// the pagination it resets: a keystroke mid-debounce must restart the
// timer and the offset together, or a stale page would leak in.
// `loading` is derived so it's visible on the render the keystroke
// caused, not after a passive effect flushes.
export function useEntitySearch({
  query,
  enabled,
  pageSize = DEFAULT_PAGE_SIZE,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  sources,
}: UseEntitySearchOptions): UseEntitySearchResult {
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [offset, setOffset] = useState(0);
  // Hold the latest fetchers without making the search depend on their
  // identity — callers (and tests) are free to hand in fresh arrow
  // functions each render without restarting the search or looping.
  const fetchersRef = useRef(sources);
  fetchersRef.current = sources;

  // True the instant a keystroke outruns the debounce and stays true until
  // that query's fetch resolves — derived here so the spinner shows on the
  // render the keystroke caused, before any passive effect runs.
  const pending = enabled && query.trim().length > 0 && debouncedQuery !== query;

  useEffect(() => {
    setOffset(0);
    if (!enabled || query.trim().length === 0) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(query), debounceMs);
    return () => clearTimeout(timer);
  }, [query, enabled, debounceMs]);

  // One fetch per committed search, cached across pages of it. A failure in
  // any source surfaces as `error` rather than a partial result set.
  const search = useQuery({
    queryKey: ["entity-search", debouncedQuery],
    enabled: debouncedQuery.trim().length > 0,
    queryFn: async (): Promise<ReadonlyMap<string, readonly SearchableEntity[]>> => {
      const current = fetchersRef.current;
      const results = await Promise.all(current.map((source) => source.fetch()));
      const map = new Map<string, readonly SearchableEntity[]>();
      for (let i = 0; i < current.length; i++) {
        const source = current[i];
        if (!source) continue;
        map.set(source.category, results[i] ?? []);
      }
      return map;
    },
  });

  const fetched = debouncedQuery.trim().length === 0 ? null : (search.data ?? null);
  const error = search.isError;
  const loading = pending || (debouncedQuery.trim().length > 0 && search.isFetching);

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
