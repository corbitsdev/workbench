import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Page chrome contract (CL-3612):
 *
 * - **List/catalog routes** publish title, counts, search, and primary actions via
 *   `useSetPageChrome` (typically `AppPageChromeRow` + controls). The scrollable pane
 *   must not render a second full-width header (`LibraryPageHeader`, bordered toolbars).
 *
 * - **Entity detail routes** publish identity through `usePublishActiveContext`
 *   (`AppContextStrip`) and trailing actions via `useSetPageChrome`. The pane avoids
 *   duplicating the title row.
 *
 * - Only `AppTopBar` owns the app-level `border-b` header band. Secondary filter rows
 *   may wrap inside the same chrome node (see artifacts gallery).
 *
 * Stabilize chrome nodes with `useMemo` and primitive deps to avoid effect loops.
 *
 * Setters and values live in separate contexts on purpose: publishers subscribe
 * only to the (stable) setters, so publishing chrome never re-renders the
 * publisher. When publisher and slot shared one context, a chrome node with
 * unstable identity re-rendered its own publisher on every publish — an
 * unbounded update loop that starved react-router navigation transitions
 * (URL changed, view never swapped).
 */

type PageChromeSetters = {
  setChrome: (node: ReactNode | null) => void;
  setLeadingChrome: (node: ReactNode | null) => void;
};

type PageChromeValues = {
  chrome: ReactNode | null;
  leadingChrome: ReactNode | null;
};

const PageChromeSettersCtx = createContext<PageChromeSetters | null>(null);
const PageChromeValuesCtx = createContext<PageChromeValues | null>(null);

export function PageChromeProvider({ children }: { children: ReactNode }) {
  const [chrome, setChromeState] = useState<ReactNode | null>(null);
  const [leadingChrome, setLeadingChromeState] = useState<ReactNode | null>(
    null,
  );
  const setChrome = useCallback((node: ReactNode | null) => {
    setChromeState(node);
  }, []);
  const setLeadingChrome = useCallback((node: ReactNode | null) => {
    setLeadingChromeState(node);
  }, []);
  const setters = useMemo(
    () => ({ setChrome, setLeadingChrome }),
    [setChrome, setLeadingChrome],
  );
  const values = useMemo(
    () => ({ chrome, leadingChrome }),
    [chrome, leadingChrome],
  );
  return (
    <PageChromeSettersCtx.Provider value={setters}>
      <PageChromeValuesCtx.Provider value={values}>
        {children}
      </PageChromeValuesCtx.Provider>
    </PageChromeSettersCtx.Provider>
  );
}

export function usePageChromeSlot(): ReactNode | null {
  return useContext(PageChromeValuesCtx)?.chrome ?? null;
}

export function usePageChromeLeadingSlot(): ReactNode | null {
  return useContext(PageChromeValuesCtx)?.leadingChrome ?? null;
}

/**
 * Mount page-specific actions in the global app header (not inside the pane).
 *
 * `enabled` (default `true`) lets a component that is sometimes embedded
 * inline inside another page's layout — rather than owning the route's
 * top-bar chrome — opt out entirely. Pass `enabled: false` in that case
 * (e.g. `useSetPageChrome(node, !embedded)`) instead of publishing `null`:
 * publishing `null` still runs the effect and overwrites whatever chrome the
 * host page published, and since the host page's own chrome node is
 * typically memoized (stable identity), its effect won't re-fire to restore
 * it — the `null` sticks (CL-4420).
 */
export function useSetPageChrome(
  node: ReactNode | null,
  enabled: boolean = true,
): void {
  const setChrome = useContext(PageChromeSettersCtx)?.setChrome;
  useEffect(() => {
    if (!enabled) return;
    setChrome?.(node);
    return () => setChrome?.(null);
  }, [node, setChrome, enabled]);
}

/** Mount page-specific leading nav in the global app header left area. */
export function useSetPageChromeLeading(node: ReactNode | null): void {
  const setLeadingChrome = useContext(PageChromeSettersCtx)?.setLeadingChrome;
  useEffect(() => {
    setLeadingChrome?.(node);
    return () => setLeadingChrome?.(null);
  }, [node, setLeadingChrome]);
}
