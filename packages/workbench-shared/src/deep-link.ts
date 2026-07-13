// The single source of truth for the in-app route an entity deep-links to.
// Every notification creator (task mail, gate mail, triage handoff, brief) and
// every UI affordance (Now feed, reading pane, bell) resolves an entity route
// through here so a route move happens in one place. An awaiting workflow run
// resolves to the SAME destination whether it is reached from a gate mail or
// the Now feed (`workflow_run` -> `/workflows/:id`, matching the app's task-link
// convention).

export const deepLinkKinds = [
  "artifact",
  "workflow_run",
  "task",
  "mail",
  "conversation",
] as const;

export type DeepLinkKind = (typeof deepLinkKinds)[number];

/** The app-relative path an entity deep-links to. */
export function deepLinkPath(kind: DeepLinkKind, id: string): string {
  switch (kind) {
    case "artifact":
      return `/artifacts/${id}`;
    case "workflow_run":
      return `/workflows/${id}`;
    case "task":
      return `/inbox?task=${encodeURIComponent(id)}`;
    case "mail":
      return `/inbox/${id}`;
    case "conversation":
      return `/chats/${id}`;
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
