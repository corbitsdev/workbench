import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type PageChromeStore = {
  chrome: ReactNode | null;
  setChrome: (node: ReactNode | null) => void;
};

const PageChromeCtx = createContext<PageChromeStore | null>(null);

export function PageChromeProvider({ children }: { children: ReactNode }) {
  const [chrome, setChromeState] = useState<ReactNode | null>(null);
  const setChrome = useCallback((node: ReactNode | null) => {
    setChromeState(node);
  }, []);
  const value = useMemo(() => ({ chrome, setChrome }), [chrome, setChrome]);
  return (
    <PageChromeCtx.Provider value={value}>{children}</PageChromeCtx.Provider>
  );
}

export function usePageChromeSlot(): ReactNode | null {
  return useContext(PageChromeCtx)?.chrome ?? null;
}

/** Mount page-specific actions in the global app header (not inside the pane). */
export function useSetPageChrome(node: ReactNode | null): void {
  const setChrome = useContext(PageChromeCtx)?.setChrome;
  useEffect(() => {
    setChrome?.(node);
    return () => setChrome?.(null);
  }, [node, setChrome]);
}