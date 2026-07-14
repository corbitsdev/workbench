// The route helper for entity kinds that surface in the notification rails —
// mailbox refs, the Now feed, gate/task/triage mail, and the reading-pane and
// bell chips. Every one of THOSE surfaces resolves through here, so a move of
// one of these five routes happens in one place, and an awaiting workflow run
// resolves to the SAME destination from a gate mail or the Now feed
// (`workflow_run` -> `/workflows/:id`, matching the app's task-link convention).
//
// This is NOT the single source of truth for every route in the app: the
// workflow dock, active-run rail, command palette, search, and insight
// trace-links still hand-build their own paths. The web router test
// (router.deep-link.test.tsx) pins the kinds below to real registered routes.

export const deepLinkKinds = [
  "artifact",
  "workflow_run",
  "task",
  "mail",
  "conversation",
] as const;

export type DeepLinkKind = (typeof deepLinkKinds)[number];

/**
 * The app-relative path an entity deep-links to. Every interpolated id is
 * percent-encoded so an id carrying a `/`, `?`, or `#` can never break out of
 * its path segment (or query value) into another route.
 */
export function deepLinkPath(kind: DeepLinkKind, id: string): string {
  const encoded = encodeURIComponent(id);
  switch (kind) {
    case "artifact":
      return `/artifacts/${encoded}`;
    case "workflow_run":
      return `/workflows/${encoded}`;
    case "task":
      return `/inbox?task=${encoded}`;
    case "mail":
      return `/inbox/${encoded}`;
    case "conversation":
      return `/chats/${encoded}`;
  }
}

/**
 * Resolve an entity's deep link. With no `baseUrl` the app-relative path is
 * returned (for react-router `<Link to>`). With a `baseUrl` an absolute URL is
 * returned — the form a Markdown mail body needs so the inbox pane autolinks
 * it into a clickable link rather than rendering a bare path as plain text.
 */
export function deepLink(
  kind: DeepLinkKind,
  id: string,
  baseUrl?: string,
): string {
  const path = deepLinkPath(kind, id);
  if (baseUrl === undefined) return path;
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
