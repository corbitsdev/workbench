import { AssetRegistrySource, type RegistrySource } from "@intx/tool-packaging";
import type { AssetService } from "@intx/hub-sessions";

/** A tenant-visible package-registry asset row: the minimum the map needs. */
export interface RegistryAssetRow {
  readonly id: string;
  readonly name: string;
}

/**
 * Build one `AssetRegistrySource` per tenant-visible package-registry asset,
 * replaying the session service's `(kind, name)` shadowing: the first
 * occurrence of a name wins (child shadows parent). `assetNameById` keeps each
 * winning asset's name per assetId so callers can derive a tarball's mount path
 * without a second DB hit.
 *
 * The Tools-page version lookup (`resolveToolVersions`) feeds the same closure
 * resolver the deploy-time tool-tree staging uses (interchange's
 * `SessionService` `buildAndResolve`), so the dedupe/shadow rule must live in
 * exactly one place — here.
 */
export function buildTenantRegistryMap(
  assetRows: readonly RegistryAssetRow[],
  assetService: AssetService,
): {
  registryMap: Map<string, RegistrySource>;
  assetNameById: Map<string, string>;
} {
  const registryMap = new Map<string, RegistrySource>();
  const assetNameById = new Map<string, string>();
  for (const row of assetRows) {
    if (registryMap.has(row.name)) continue;
    assetNameById.set(row.id, row.name);
    registryMap.set(
      row.name,
      new AssetRegistrySource({
        name: row.name,
        assetId: row.id,
        readBlob: (path) =>
          assetService.readAssetBlob({ assetId: row.id, path }),
        listBlobs: (dir) =>
          assetService.listAssetBlobs({ assetId: row.id, dir }),
      }),
    );
  }
  return { registryMap, assetNameById };
}
