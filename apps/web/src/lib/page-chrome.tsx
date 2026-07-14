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
 */

type PageChromeStore = {
  chrome: ReactNode | null;
  setChrome: (node: ReactNode | null) => void;
  leadingChrome: ReactNode | null;
  setLeadingChrome: (node: ReactNode | null) => void;
};

const PageChromeCtx = createContext<PageChromeStore | null>(null);

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
  const value = useMemo(
    () => ({ chrome, setChrome, leadingChrome, setLeadingChrome }),
    [chrome, setChrome, leadingChrome, setLeadingChrome],
  );
  return (
    <PageChromeCtx.Provider value={value}>{children}</PageChromeCtx.Provider>
  );
}

export function usePageChromeSlot(): ReactNode | null {
  return useContext(PageChromeCtx)?.chrome ?? null;
}

export function usePageChromeLeadingSlot(): ReactNode | null {
  return useContext(PageChromeCtx)?.leadingChrome ?? null;
}

/** Mount page-specific actions in the global app header (not inside the pane). */
export function useSetPageChrome(node: ReactNode | null): void {
  const setChrome = useContext(PageChromeCtx)?.setChrome;
  useEffect(() => {
    setChrome?.(node);
    return () => setChrome?.(null);
  }, [node, setChrome]);
}

/** Mount page-specific leading nav in the global app header left area. */
export function useSetPageChromeLeading(node: ReactNode | null): void {
  const setLeadingChrome = useContext(PageChromeCtx)?.setLeadingChrome;
  useEffect(() => {
    setLeadingChrome?.(node);
    return () => setLeadingChrome?.(null);
  }, [node, setLeadingChrome]);
}
