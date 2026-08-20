// The one site naming the tenant-scoped package-registry asset that
// resolves `@corbits/*` tool-package pins, and the packages published
// into it. A rename or an added package changes one file instead of
// chasing string literals across `apps/hub` (scope routing) and every
// publish call site — the same reasoning `WORKSPACE_BUILTINS_REGISTRY`
// documents in vendor/intx/hub-sessions/src/package-registry-kind.ts.

/**
 * Asset name the hub's `@corbits` scope routing resolves tool-package
 * pins against (`apps/hub/src/index.ts`'s `CORBITS_TOOLS_REGISTRY`).
 * Kept here so the publisher and the hub's scope-routing config read
 * the same literal.
 */
export const CORBITS_TOOLS_REGISTRY = "corbits-tools";

/**
 * Absolute directories of the `@corbits/*-tools` packages published
 * into the `corbits-tools` registry. Every workflow's
 * `toolPackagePins` under the `@corbits` scope must name a package
 * listed here, or its pin never resolves. `capability-tools`
 * (CL-6084/CL-6086) is published here and pinned into every drafted
 * agent's default tool-package set — see `@corbits/capability-tools`'s
 * README for how its request_capability tool reaches the hub.
 */
export const CORBITS_TOOL_PACKAGE_DIRS: readonly string[] = [
  new URL("../../memory-tools", import.meta.url).pathname,
  new URL("../../capability-tools", import.meta.url).pathname,
  new URL("../../routines-tools", import.meta.url).pathname,
  new URL("../../task-dispatch-tools", import.meta.url).pathname,
  new URL("../../connections-tools", import.meta.url).pathname,
  new URL("../../catalog-tools", import.meta.url).pathname,
  new URL("../../agent-directory-tools", import.meta.url).pathname,
  new URL("../../interaction-tools", import.meta.url).pathname,
  new URL("../../skills-tools", import.meta.url).pathname,
  new URL("../../mcp-tools", import.meta.url).pathname,
  new URL("../../tools-skills", import.meta.url).pathname,
  new URL("../../github-tools", import.meta.url).pathname,
  new URL("../../web-search-tools", import.meta.url).pathname,
  new URL("../../granola-tools", import.meta.url).pathname,
  new URL("../../linear-tools", import.meta.url).pathname,
];
