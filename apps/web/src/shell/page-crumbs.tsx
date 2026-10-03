// A full-page view opened from a workbench carries `?from=<workbench id>`,
// so the page scopes its data to the originating bench and the drill-in
// links it renders keep the bench context. No breadcrumb trail renders
// app-wide (CL-9787) — this module only threads the scope parameter.

import { useSyncExternalStore } from "react";

import { getPath, subscribeToPath } from "../router-store";

const FROM_PARAM = "from";

/** `path` with the originating workbench appended, for any link that opens a
 * full-page view from a workbench. */
export function benchLink(path: string, benchId: string | null): string {
  if (benchId === null) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set(FROM_PARAM, benchId);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The workbench tenant id named by `?from=`, or null. Full-page views scope
 * their data to it instead of the last-opened workbench. */
export function useFromBench(): string | null {
  // The path store re-renders this on navigation; it keeps the pathname
  // only, so the query string is read fresh.
  useSyncExternalStore(subscribeToPath, getPath);
  const id = new URLSearchParams(window.location.search).get(FROM_PARAM);
  return id === null || id === "" ? null : id;
}
