import { useEffect, useRef, useState } from "react";

import { searchEntities } from "./entity-search";
import type { EntitySearchResult, SearchableEntity } from "./entity-search";

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_DEBOUNCE_MS = 200;

export type UseEntitySearchOptions = {
  readonly query: string;
  /** Skip fetching entirely while the palette is closed. */
  readonly enabled: boolean;
  readonly pageSize?: number;
  readonly debounceMs?: number;
  readonly listChannels: () => Promise<readonly SearchableEntity[]>;
  readonly listRuns: () => Promise<readonly SearchableEntity[]>;
};

export type UseEntitySearchResult = {
  readonly results: readonly EntitySearchResult[];
  readonly loading: boolean;
  readonly error: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
};

/**
 * Debounces a typed query, fetches channels and workflow runs once per
 * search (cached across pages of the same search), and matches/paginates
 * them via `searchEntities`. Debouncing lives here rather than in the app
 * shell because it is inseparable from the pagination it resets: a
 * keystroke that arrives mid-debounce must restart the timer *and* the
 * offset together, or a stale page from the previous query would leak into
 * the new one.
 *
 * `loading` is derived, not just set in an effect: the moment a keystroke
 * makes `query` outrun the debounce-committed `debouncedQuery`, the hook is
 * `pending`, and that is visible on the very render the keystroke caused —
 * no waiting for a passive effect to flush. It stays true through the fetch
 * (`fetching`) and only drops once that query's results are ready.
 *
 * Artifacts and agent definitions are not searched here — see
 * docs/command-palette.md for why those two entity types have nothing to
 * query yet.
 */
export function useEntitySearch({
  query,
  enabled,
  pageSize = DEFAULT_PAGE_SIZE,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  listChannels,
  listRuns,
}: UseEntitySearchOptions): UseEntitySearchResult {
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [entities, setEntities] = useState<{
    readonly channels: readonly SearchableEntity[];
    readonly runs: readonly SearchableEntity[];
  } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(false);
  const fetchToken = useRef(0);
  // Hold the latest fetchers without making the fetch effect depend on their
  // identity — callers (and tests) are free to hand in fresh arrow functions
  // each render without restarting the search or looping.
  const fetchers = useRef({ listChannels, listRuns });
  fetchers.current = { listChannels, listRuns };

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
      setEntities(null);
      setFetching(false);
      setError(false);
      return;
    }
    const token = ++fetchToken.current;
    setFetching(true);
    setError(false);
    void Promise.all([
      fetchers.current.listChannels(),
      fetchers.current.listRuns(),
    ])
      .then(([channels, runs]) => {
        if (token !== fetchToken.current) return;
        setEntities({ channels, runs });
        setFetching(false);
      })
      .catch(() => {
        if (token !== fetchToken.current) return;
        setError(true);
        setFetching(false);
      });
  }, [debouncedQuery]);

  const loading = pending || fetching;

  if (entities === null || debouncedQuery.trim().length === 0) {
    return {
      results: [],
      loading,
      error,
      hasMore: false,
      loadMore: () => setOffset(0),
    };
  }

  const page = searchEntities({
    query: debouncedQuery,
    channels: entities.channels,
    runs: entities.runs,
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
