// A screen that only exists to forward. The hop happens during render, not
// from an effect, so the route it leaves never paints a frame of its own —
// the router store publishes the new path on a microtask, so nothing is
// updated mid-render.

import { useRef } from "react";

import type { Navigate } from "./navigation";

/** Scheduled from render on a microtask, and at most once per target: the
 * hop leaves this render alone (nothing is updated mid-render) yet still
 * lands before the browser paints the route it is leaving. */
export function Redirect({
  to,
  from,
  navigate,
}: {
  readonly to: string;
  readonly from: string;
  readonly navigate: Navigate;
}) {
  const sent = useRef<string | null>(null);
  if (sent.current !== to && from !== new URL(to, window.location.origin).pathname) {
    sent.current = to;
    queueMicrotask(() => navigate(to));
  }
  return null;
}
