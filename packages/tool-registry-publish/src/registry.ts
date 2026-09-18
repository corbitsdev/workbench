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
 * Package names a seeded `corbits-tools` registry must carry for the
 * default workflow set to launch. Default workflows pin at least these
 * (Myra's assistant pins `@corbits/capability-tools` into every drafted
 * agent's default tool-package set); an empty or dangling registry — a
 * package-registry row whose git repo has no tarball commits — is not
 * seeded. `@corbits/memory` is not listed here: it is a
 * published dependency this repo does not build or publish into this
 * registry itself, not one of the workspace `packages/*-tools` this
 * publisher packs.
 */
export const REQUIRED_SEED_TOOL_PACKAGES = ["@corbits/capability-tools"] as const;

/** True when `filename` is an npm-style tarball for `packageName` (any version). */
export function tarballCoversPackage(filename: string, packageName: string): boolean {
  const prefix = `${packageName.replace(/^@/, "").replace("/", "-")}-`;
  return filename.startsWith(prefix) && filename.endsWith(".tgz");
}

/**
 * Whether a tarball listing is enough for first-run launch: non-empty
 * and covering every `REQUIRED_SEED_TOOL_PACKAGES` entry. An empty list
 * is the dangling-asset case (`GET tarballs` → `[]` after git init with
 * no commit).
 */
export function tarballsCoverRequiredSeedPackages(filenames: Iterable<string>): boolean {
  const list = [...filenames];
  if (list.length === 0) return false;
  return REQUIRED_SEED_TOOL_PACKAGES.every((name) =>
    list.some((filename) => tarballCoversPackage(filename, name)),
  );
}

/**
 * Absolute directories of the `@corbits/*-tools` packages published
 * into the `corbits-tools` registry. Every workflow's
 * `toolPackagePins` under the `@corbits` scope must name a package
 * listed here, or its pin never resolves. `capability-tools`
 * is published here and pinned into every drafted
 * agent's default tool-package set — see `@corbits/capability-tools`'s
 * README for how its request_capability tool reaches the hub.
 */
export const CORBITS_TOOL_PACKAGE_DIRS: readonly string[] = [
  new URL("../../../tools/capability", import.meta.url).pathname,
  new URL("../../../tools/catalog", import.meta.url).pathname,
  new URL("../../../tools/agent-directory", import.meta.url).pathname,
  new URL("../../../tools/access", import.meta.url).pathname,
  new URL("../../../tools/interaction", import.meta.url).pathname,
  new URL("../../../tools/skills-tools", import.meta.url).pathname,
  new URL("../../../tools/tools-skills", import.meta.url).pathname,
  new URL("../../../tools/github", import.meta.url).pathname,
  new URL("../../../tools/web-search", import.meta.url).pathname,
  new URL("../../../tools/granola", import.meta.url).pathname,
  new URL("../../../tools/linear", import.meta.url).pathname,
  new URL("../../../tools/workflow-authoring", import.meta.url).pathname,
];
