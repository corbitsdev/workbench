// The one site naming the tenant-scoped package-registry asset that
// resolves `@corbits/*` tool-package pins, so a rename touches one file.

/** Asset name the hub's `@corbits` scope routing resolves pins against. */
export const CORBITS_TOOLS_REGISTRY = "corbits-tools";

/** True when `filename` is an npm-style tarball for `packageName` (any version). */
export function tarballCoversPackage(filename: string, packageName: string): boolean {
  const prefix = `${packageName.replace(/^@/, "").replace("/", "-")}-`;
  return filename.startsWith(prefix) && filename.endsWith(".tgz");
}
