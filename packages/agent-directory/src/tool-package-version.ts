// CL-7389: a runtime tool-package pin must resolve to a concrete,
// published version — never the npm "any version" range `*` — so a new
// tarball landing in the tenant's registry never silently changes what
// an already-deployed specialist runs. `withAgentToolPackagePin` (see
// `./agent-workflow.ts`) rejects `"*"` at its own boundary; this module
// is the one place a caller that only has a package *name* (guided
// capability-add, `create_agent`'s own tool-package pins) resolves it to
// the version to pin instead.
//
// The tenant's usable tool packages are published as npm-style tarballs
// into its (possibly inherited) `corbits-tools` `package-registry`
// asset — the exact same asset `@intx/tool-packaging`'s
// `AssetRegistrySource` reads from at deploy-assembly time
// (`vendor/intx/hub-sessions/src/session-service.ts`'s `buildAndResolve`).
// Reading the tarball listing directly here, rather than re-deriving a
// packument, keeps this resolver a plain filename scan: exactly the
// same `tarballCoversPackage` filter `@corbits/tool-registry-publish`
// already uses to decide whether a registry carries a given package.
import semver from "semver";

import type { DB } from "@intx/db";
import { resolveAssetByName } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";

import {
  CORBITS_TOOLS_REGISTRY,
  tarballCoversPackage,
} from "@corbits/tool-registry-publish";

import { CapabilityOutOfInventoryError } from "./capability-inventory";

const TARBALLS_DIR = "tarballs";

/** A resolved runtime pin: a package name paired with the highest
 * published version the tenant's registry currently carries for it. */
export type ResolvedToolPackagePin = {
  readonly name: string;
  readonly version: string;
};

export type ResolvePinnedVersionDeps = {
  readonly db: DB["db"];
  readonly assetService: AssetService;
};

/** The `<name>-<version>.tgz` filename convention
 * `tarballFilenameFor`/`packToolPackageTarball` (`@corbits/tool-registry-publish`'s
 * `pack.ts`) write into a registry's `tarballs/` tree. Returns `null`
 * for a filename that does not cover `packageName` or does not parse as
 * a valid semver version — a defensively-shaped filename is treated as
 * absent rather than crashing the resolution. */
function versionFromTarballFilename(
  filename: string,
  packageName: string,
): string | null {
  if (!tarballCoversPackage(filename, packageName)) return null;
  const prefix = `${packageName.replace(/^@/, "").replace("/", "-")}-`;
  const version = filename.slice(prefix.length, -".tgz".length);
  return semver.valid(version) !== null ? version : null;
}

/**
 * Resolves `packageName` against the tenant's (possibly inherited)
 * `corbits-tools` registry to `{ name, version }`, `version` always the
 * highest published semver among the registry's tarballs for that
 * package — never `*`, so a runtime pin is reproducible: a later
 * tarball landing in the registry changes what a *new* pin resolves to,
 * never what an already-deployed definition's stored pin resolves to.
 *
 * Throws `CapabilityOutOfInventoryError` — the same fail-closed error
 * `assertCapabilityInInventory` throws for any other out-of-inventory
 * addition, so every caller's existing `CapabilityOutOfInventoryError`
 * -> 4xx mapping (`./routes.ts`, `./workflow-capability-routes.ts`)
 * covers this case with no new wiring — when the tenant has no visible
 * `corbits-tools` registry, or that registry carries no tarball for
 * `packageName`.
 */
export async function resolvePinnedVersion(
  deps: ResolvePinnedVersionDeps,
  tenantId: string,
  packageName: string,
): Promise<ResolvedToolPackagePin> {
  const registryAsset = await resolveAssetByName(
    deps.db,
    tenantId,
    "package-registry",
    CORBITS_TOOLS_REGISTRY,
  );
  if (registryAsset === null) {
    throw new CapabilityOutOfInventoryError("toolPackage", packageName);
  }

  const filenames = await deps.assetService.listAssetBlobs({
    assetId: registryAsset.id,
    dir: TARBALLS_DIR,
  });
  const versions = filenames
    .map((filename) => versionFromTarballFilename(filename, packageName))
    .filter((version): version is string => version !== null);
  const highest = versions.sort(semver.compare).at(-1);
  if (highest === undefined) {
    throw new CapabilityOutOfInventoryError("toolPackage", packageName);
  }

  return { name: packageName, version: highest };
}
