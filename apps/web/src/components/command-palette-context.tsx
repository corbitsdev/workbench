import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import type { PaletteResultItem } from "@workbench/shared";
import { CommandPalette } from "./CommandPalette";
import { NAV_COMMANDS } from "../router";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { searchPaletteEntities } from "../lib/palette-search";

interface CommandPaletteContextValue {
  open: boolean;
  openPalette: () => void;
  closePalette: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue>({
  open: false,
  openPalette: () => {},
  closePalette: () => {},
});

export function useCommandPalette(): CommandPaletteContextValue {
  return useContext(CommandPaletteContext);
}

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Owns command-palette state and the global Cmd/Ctrl+K listener. Static nav
 * commands are matched client-side; entity results (chats, agents, workflows,
 * artifacts, skills, tools) come from the server-side aggregate search
 * (`/api/tenants/:tenantId/search`, CL-2500), debounced and paginated via
 * TanStack `useInfiniteQuery`. Navigates on selection.
 */
export function CommandPaletteProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const { activeTenantId } = useActiveWorkbench();

  const resetQuery = useCallback(() => {
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    setQuery("");
    setDebouncedQuery("");
  }, []);

  const openPalette = useCallback(() => {
    resetQuery();
    setOpen(true);
  }, [resetQuery]);

  const closePalette = useCallback(() => {
    resetQuery();
    setOpen(false);
  }, [resetQuery]);

  // Mirror `open` into a ref so the global chord listener (registered once) can
  // route through the reset-aware open/close callbacks without re-subscribing.
  const openRef = useRef(open);
  openRef.current = open;

  // The query input debounces into `debouncedQuery`, which keys the search query
  // so a new keystroke resets pagination (fresh queryKey) without firing a
  // request per character. A plain event handler, not an effect.
  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(value);
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  // A global chord listener is a subscription to an external event source — the
  // legitimate use of an effect. Capture phase so it fires regardless of which
  // element (including form inputs) currently holds focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (openRef.current) closePalette();
        else openPalette();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openPalette, closePalette]);

  const trimmed = debouncedQuery.trim();
  const search = useInfiniteQuery({
    queryKey: ["palette-search", activeTenantId, trimmed],
    enabled: open && activeTenantId != null && trimmed !== "",
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      searchPaletteEntities(
        activeTenantId as string,
        trimmed,
        pageParam,
        signal,
      ),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.page + 1 : undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const entityItems = useMemo<PaletteResultItem[]>(
    () => search.data?.pages.flatMap((page) => page.results) ?? [],
    [search.data],
  );

  const onSelect = useCallback(
    (item: PaletteResultItem) => {
      closePalette();
      navigate(item.to);
    },
    [closePalette, navigate],
  );

  const onLoadMore = useCallback(() => {
    void search.fetchNextPage();
  }, [search]);

  const value = useMemo<CommandPaletteContextValue>(
    () => ({ open, openPalette, closePalette }),
    [open, openPalette, closePalette],
  );

  return (
    <CommandPaletteContext value={value}>
      {children}
      <CommandPalette
        open={open}
        onClose={closePalette}
        query={query}
        onQueryChange={handleQueryChange}
        navItems={NAV_COMMANDS}
        entityItems={entityItems}
        onSelect={onSelect}
        loading={search.isFetching}
        error={search.isError}
        hasMore={search.hasNextPage}
        onLoadMore={onLoadMore}
      />
    </CommandPaletteContext>
  );
}
