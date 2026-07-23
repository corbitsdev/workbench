/**
 * Canonical in-app deep-link paths for workbench entities.
 *
 * Use these helpers instead of hand-built `/artifacts/...` strings so mail,
 * notifications, and UI stay aligned with the router.
 */
export const deepLinkKinds = [
  "artifact",
  "workflow_run",
  "workflow_trace",
  "task",
  "mail",
  "conversation",
] as const;

export type DeepLinkKind = (typeof deepLinkKinds)[number];

export function deepLinkPath(kind: DeepLinkKind, id: string): string {
  switch (kind) {
    case "artifact":
      return `/library/artifacts/${encodeURIComponent(id)}`;
    case "workflow_run":
      return `/workflows/${encodeURIComponent(id)}`;
    case "workflow_trace":
      return `/insights/trace/${encodeURIComponent(id)}`;
    case "task":
      return `/inbox?task=${encodeURIComponent(id)}`;
    case "mail":
      return `/inbox/${encodeURIComponent(id)}`;
    case "conversation":
      return `/chats/${encodeURIComponent(id)}`;
  }
}

/** Absolute URL when `baseUrl` is set; otherwise the same path as {@link deepLinkPath}. */
export function deepLink(
  kind: DeepLinkKind,
  id: string,
  baseUrl?: string,
): string {
  const path = deepLinkPath(kind, id);
  if (!baseUrl) return path;
  const base = baseUrl.replace(/\/$/, "");
  return `${base}${path}`;
}
