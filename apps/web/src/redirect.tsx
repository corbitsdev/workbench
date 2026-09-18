// A screen that only exists to forward. The hop happens during render, not
// from an effect, so the route it leaves never paints a frame of its own —
// the router store publishes the new path on a microtask, so nothing is
// updated mid-render.

import type { Navigate } from "./navigation";

/** Idempotent across re-renders: the hop only fires while the current path
 * still differs from the target. */
export function Redirect({
  to,
  from,
  navigate,
}: {
  readonly to: string;
  readonly from: string;
  readonly navigate: Navigate;
}) {
  if (from !== new URL(to, window.location.origin).pathname) {
    navigate(to);
  }
  return null;
}
