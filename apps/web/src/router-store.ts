// The browser history as an external store: the path lives outside React,
// so the shell subscribes with `useSyncExternalStore` instead of an effect
// that registers a `popstate` listener after the first paint. Retired paths
// are canonicalized here, before any screen mounts — a bookmark to
// `/files/a1` becomes `/artifacts/a1` in the URL bar and in the store, and
// no route entry exists just to bounce it.

import { redirectTargetFor } from "./routes";

function canonicalPath(pathname: string): string {
  return redirectTargetFor(pathname) ?? pathname;
}

const listeners = new Set<() => void>();

let currentPath = canonicalPath(window.location.pathname);
if (currentPath !== window.location.pathname) {
  window.history.replaceState(null, "", currentPath);
}

function setPath(next: string): void {
  if (next === currentPath) return;
  currentPath = next;
  // Published on a microtask so a render-phase `navigateTo` (a forwarding
  // route resolving its target) never updates a subscriber mid-render.
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });
}

window.addEventListener("popstate", () => {
  const canonical = canonicalPath(window.location.pathname);
  if (canonical !== window.location.pathname) {
    window.history.replaceState(null, "", canonical);
  }
  setPath(canonical);
});

export function subscribeToPath(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPath(): string {
  return currentPath;
}

/**
 * Push a new entry and publish the new path. The store keeps the pathname
 * only — every comparison against it (`matchesRoute`, `LOGIN_PATH`,
 * `ONBOARDING_PATH`) expects a bare path — while a query string like
 * `/login?next=...` still reaches the URL bar.
 */
export function navigateTo(to: string): void {
  const url = new URL(to, window.location.origin);
  const canonical = canonicalPath(url.pathname);
  // A hop to the path already showing is a no-op, which is what makes a
  // render-phase `navigate` safe to run twice (StrictMode, a re-render):
  // it can never stack duplicate history entries.
  if (canonical === currentPath) return;
  window.history.pushState(null, "", canonical === url.pathname ? to : canonical);
  setPath(canonical);
}
