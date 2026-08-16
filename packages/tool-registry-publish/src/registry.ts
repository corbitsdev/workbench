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
 * listed here, or its pin never resolves. `capability-tools` (CL-6084)
 * is published here even though nothing pins it by default yet — see
 * `@corbits/capability-tools`'s README for the two open gaps blocking a
 * live pin.
 */
export const CORBITS_TOOL_PACKAGE_DIRS: readonly string[] = [
  new URL("../../memory-tools", import.meta.url).pathname,
  new URL("../../capability-tools", import.meta.url).pathname,
];
