import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import {
  AssetServiceError,
  type AssetService,
  validateTarballPackageJSON,
} from "@workbench/hub-sessions";
import type { HubDb } from "../db";
import { integrityFromTarballBytes } from "./tool-packages-embedded";

const log = getLogger(["lib", "package-registry-hierarchy-guard"]);

// Retained deliberately: CL-3783 softened the boot path to log (not throw) on a
// cross-asset byte divergence. The proper fix (single asset per tenant /
// normalized-content compare) re-introduces this throw, so keep it exported.
export class PackageRegistryHierarchyCollisionError extends Error {
  readonly reason = "package_registry_hierarchy_collision" as const;

  constructor(message: string) {
    super(message);
    this.name = "PackageRegistryHierarchyCollisionError";
  }
}

export class PackageRegistryTarballInvalidError extends Error {
  readonly reason = "package_registry_tarball_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "PackageRegistryTarballInvalidError";
  }
}

export type RegistryAssetRow = { id: string; name: string };

export interface PackageRegistryCrossAssetCollision {
  nameVersion: string;
  assetA: string;
  assetB: string;
}

export async function listPackageRegistryAssetsOnTenant(
  db: HubDb,
  tenantId: string,
): Promise<RegistryAssetRow[]> {
  return db
    .select({
      id: intxSchema.asset.id,
      name: intxSchema.asset.name,
    })
    .from(intxSchema.asset)
    .where(
      and(
        eq(intxSchema.asset.tenantId, tenantId),
        eq(intxSchema.asset.kind, "package-registry"),
      ),
    );
}

export function isMissingRegistryPathError(err: unknown): boolean {
  if (err instanceof AssetServiceError && err.reason === "not_found") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("has no blob at");
}

/**
 * Detect (and, historically, fail loud on) multiple package-registry assets on
 * one tenant publishing the same `name@version` with different tarball bytes
 * (CL-3656). This deliberately, temporarily softens that fail-fast: a cross-asset
 * byte divergence is now returned to the caller and logged at error level rather
 * than thrown, so a stray asset holding a stale tarball can never crash-loop the
 * hub on boot. The boot path reconciles every asset to the embedded bytes first,
 * so residual collisions here are orphans (a `name@version` present only in a
 * stray asset). The proper fix (single asset per tenant / normalized-content
 * compare) is tracked in CL-3783. Genuine tarball corruption still throws
 * (PackageRegistryTarballInvalidError).
 */
export async function assertNoCrossAssetPackageRegistryCollisions(args: {
  db: HubDb;
  assetService: AssetService;
  tenantId: string;
}): Promise<PackageRegistryCrossAssetCollision[]> {
  const assets = await listPackageRegistryAssetsOnTenant(
    args.db,
    args.tenantId,
  );
  if (assets.length <= 1) return [];

  const byNameVersion = new Map<
    string,
    { integrity: string; assetName: string; filename: string }
  >();
  const collisions: PackageRegistryCrossAssetCollision[] = [];

  for (const asset of assets) {
    let filenames: string[];
    try {
      filenames = await args.assetService.listAssetBlobs({
        assetId: asset.id,
        dir: "tarballs",
      });
    } catch (err) {
      if (isMissingRegistryPathError(err)) continue;
      throw err;
    }

    for (const filename of filenames) {
      const path = `tarballs/${filename}`;
      let bytes: Uint8Array;
      try {
        bytes = await args.assetService.readAssetBlob({
          assetId: asset.id,
          path,
        });
      } catch (err) {
        if (isMissingRegistryPathError(err)) continue;
        throw err;
      }

      const outcome = await validateTarballPackageJSON(filename, bytes);
      if (!outcome.ok) {
        throw new PackageRegistryTarballInvalidError(
          `package-registry asset ${asset.name} (${asset.id}) tarball ${filename} is invalid: ${outcome.reason}`,
        );
      }

      const key = `${outcome.pkg.name}@${outcome.pkg.version}`;
      const integrity = integrityFromTarballBytes(bytes);
      const prev = byNameVersion.get(key);
      if (prev !== undefined && prev.integrity !== integrity) {
        collisions.push({
          nameVersion: key,
          assetA: prev.assetName,
          assetB: asset.name,
        });
        log.error(
          "package-registry cross-asset byte divergence (boot continues; see CL-3783)",
          {
            nameVersion: key,
            assetA: prev.assetName,
            assetAFilename: prev.filename,
            assetB: asset.name,
            assetBFilename: filename,
          },
        );
        continue;
      }
      if (prev === undefined) {
        byNameVersion.set(key, {
          integrity,
          assetName: asset.name,
          filename,
        });
      }
    }
  }

  return collisions;
}
