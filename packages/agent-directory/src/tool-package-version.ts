// A runtime tool-package pin must resolve to a concrete, published version
// — never the npm "any version" range `*` — so a new tarball landing in
// the registry never silently changes what an already-deployed specialist
// runs. This is the one place a caller with only a package name resolves
// it to a pinnable version.
import semver from "semver";

import type { DB } from "@intx/db";
import { resolveAssetByName } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";

import { CORBITS_TOOLS_REGISTRY, tarballCoversPackage } from "./tool-registry";

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

/** Parses the `<name>-<version>.tgz` filename convention. Returns `null`
 * for a filename that doesn't cover `packageName` or parse as semver,
 * treated as absent rather than crashing resolution. */
function versionFromTarballFilename(filename: string, packageName: string): string | null {
  if (!tarballCoversPackage(filename, packageName)) return null;
  const prefix = `${packageName.replace(/^@/, "").replace("/", "-")}-`;
  const version = filename.slice(prefix.length, -".tgz".length);
  return semver.valid(version) !== null ? version : null;
}

/** The highest version, preferring stable over prerelease — without this a
 * `2.0.0-rc.1` could silently outrank a published `1.9.0`. */
function highestPreferringStable(versions: readonly string[]): string | undefined {
  const stable = versions.filter((version) => semver.prerelease(version) === null);
  const candidates = stable.length > 0 ? stable : versions;
  return candidates.slice().sort(semver.compare).at(-1);
}

/** Resolves `packageName` against an already-loaded tarball `filenames`
 * listing. See `createPinnedVersionResolver` to reuse the listing. */
function resolveFromFilenames(
  filenames: readonly string[],
  packageName: string,
): ResolvedToolPackagePin {
  const versions = filenames
    .map((filename) => versionFromTarballFilename(filename, packageName))
    .filter((version): version is string => version !== null);
  const highest = highestPreferringStable(versions);
  if (highest === undefined) {
    throw new CapabilityOutOfInventoryError("toolPackage", packageName);
  }
  return { name: packageName, version: highest };
}

/** Builds a resolver that loads the registry's tarball listing at most
 * once, reused across every call. Prefer this over `resolvePinnedVersion`
 * when resolving several names in one request. */
export function createPinnedVersionResolver(
  deps: ResolvePinnedVersionDeps,
  tenantId: string,
): (packageName: string) => Promise<ResolvedToolPackagePin> {
  let filenamesPromise: Promise<readonly string[] | null> | undefined;
  const loadFilenames = (): Promise<readonly string[] | null> => {
    filenamesPromise ??= (async () => {
      const registryAsset = await resolveAssetByName(
        deps.db,
        tenantId,
        "package-registry",
        CORBITS_TOOLS_REGISTRY,
      );
      if (registryAsset === null) return null;
      return deps.assetService.listAssetBlobs({
        assetId: registryAsset.id,
        dir: TARBALLS_DIR,
      });
    })();
    return filenamesPromise;
  };

  return async (packageName: string) => {
    const filenames = await loadFilenames();
    if (filenames === null) {
      throw new CapabilityOutOfInventoryError("toolPackage", packageName);
    }
    return resolveFromFilenames(filenames, packageName);
  };
}

/** Resolves `packageName` to `{ name, version }`, the highest published
 * stable semver, never `*`. Throws `CapabilityOutOfInventoryError` when
 * unresolvable. Build a `createPinnedVersionResolver` instead for several
 * names in one request. */
export async function resolvePinnedVersion(
  deps: ResolvePinnedVersionDeps,
  tenantId: string,
  packageName: string,
): Promise<ResolvedToolPackagePin> {
  return createPinnedVersionResolver(deps, tenantId)(packageName);
}
