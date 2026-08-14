// Scroll position is per-route state, not global: landing on a new page
// should start at the top instead of inheriting however far the previous
// page was scrolled. This resets the main pane's own scroll container to
// the top whenever the route changes. Extracted as its own hook so the
// behaviour is unit-testable without mounting the whole shell.

import { useEffect, type RefObject } from "react";

/** Scrolls `ref` back to the top whenever `dep` changes. No-op while the
 * ref is unattached. */
export function useScrollReset<T extends Element>(
  ref: RefObject<T | null>,
  dep: unknown,
): void {
  useEffect(() => {
    if (ref.current !== null) ref.current.scrollTop = 0;
    // `ref` is a stable identity; `dep` is what actually triggers a reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
}
