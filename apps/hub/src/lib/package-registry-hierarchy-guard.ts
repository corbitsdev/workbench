import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import {
  type AssetService,
  validateTarballPackageJSON,
} from "@intx/hub-sessions";
import type { HubDb } from "../db";
import { integrityFromTarballBytes } from "./tool-packages-embedded";

export class PackageRegistryHierarchyCollisionError extends Error {
  readonly reason = "package_registry_hierarchy_collision" as const;

  constructor(message: string) {
    super(message);
    this.name = "PackageRegistryHierarchyCollisionError";
  }
}

type RegistryAssetRow = { id: string; name: string };

async function listPackageRegistryAssetsOnTenant(
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

function isMissingTarballsDirectoryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("has no directory at") ||
    message.includes("has no blob at")
  );
}

/**
 * Fail loud when multiple package-registry assets on one tenant publish the same
 * `name@version` with different tarball bytes (CL-3656). Per-asset pushes are
 * already guarded in Interchange; this covers cross-asset collisions at boot.
 */
export async function assertNoCrossAssetPackageRegistryCollisions(args: {
  db: HubDb;
  assetService: AssetService;
  tenantId: string;
}): Promise<void> {
  const assets = await listPackageRegistryAssetsOnTenant(
    args.db,
    args.tenantId,
  );
  if (assets.length <= 1) return;

  const byNameVersion = new Map<
    string,
    { integrity: string; assetName: string; filename: string }
  >();

  for (const asset of assets) {
    let filenames: string[];
    try {
      filenames = await args.assetService.listAssetBlobs({
        assetId: asset.id,
        dir: "tarballs",
      });
    } catch (err) {
      if (isMissingTarballsDirectoryError(err)) continue;
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
        if (isMissingTarballsDirectoryError(err)) continue;
        throw err;
      }

      const outcome = await validateTarballPackageJSON(filename, bytes);
      if (!outcome.ok) {
        throw new PackageRegistryHierarchyCollisionError(
          `package-registry asset ${asset.name} (${asset.id}) tarball ${filename} is invalid: ${outcome.reason}`,
        );
      }

      const key = `${outcome.pkg.name}@${outcome.pkg.version}`;
      const integrity = integrityFromTarballBytes(bytes);
      const prev = byNameVersion.get(key);
      if (prev !== undefined && prev.integrity !== integrity) {
        throw new PackageRegistryHierarchyCollisionError(
          `package-registry hierarchy contains duplicate ${key} with different content across assets ` +
            `${JSON.stringify(prev.assetName)} (${prev.filename}) and ${JSON.stringify(asset.name)} (${filename})`,
        );
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
}
