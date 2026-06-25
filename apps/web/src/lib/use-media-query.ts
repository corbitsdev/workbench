import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query and re-render when it changes. Uses
 * useSyncExternalStore so there is no effect/state to keep in sync — the
 * matchMedia list IS the external store. Returns false during SSR.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(
    () => window.matchMedia(query).matches,
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
