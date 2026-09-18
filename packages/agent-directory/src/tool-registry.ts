// The one site naming the tenant-scoped package-registry asset that
// resolves `@corbits/*` tool-package pins, and the filename filter that
// decides whether a registry's tarball listing carries a given package.
// A rename changes one file instead of chasing string literals across
// `apps/hub` (scope routing) and every publish call site.

/**
 * Asset name the hub's `@corbits` scope routing resolves tool-package
 * pins against (`apps/hub/src/index.ts`'s `CORBITS_TOOLS_REGISTRY`).
 */
export const CORBITS_TOOLS_REGISTRY = "corbits-tools";

/** True when `filename` is an npm-style tarball for `packageName` (any version). */
export function tarballCoversPackage(filename: string, packageName: string): boolean {
  const prefix = `${packageName.replace(/^@/, "").replace("/", "-")}-`;
  return filename.startsWith(prefix) && filename.endsWith(".tgz");
}
