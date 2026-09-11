// CL-6149: a launch's pinned tool packages (`toolPackagePins`) carry no
// grants of their own — the deploy-time capability walk
// (`vendor/intx/workflow-deploy/src/capability-walk.ts`) only derives
// `tool:` grants for inline tool factories, so a pinned package's tools
// failed every call closed with "No matching grants". Given a launch's
// pins, this reads the tenant-resolved `corbits-tools` package-registry
// asset's packed tarballs through `readToolSurfaceManifests` and mints
// one `tool:<qualifiedId>` / `invoke` declaration per tool, floored at
// `ask` for a tool the package itself marks `approval: "ask"` — the
// grants come from the installed asset's own manifest, never from a
// source import.
import type {
  PinnedToolGrantDeclaration,
  ToolGrantsForPins,
} from "@corbits/chat";
import {
  CORBITS_TOOLS_REGISTRY,
  readToolSurfaceManifests,
  type ToolSurfaceBlobSource,
} from "@corbits/tool-registry-publish";
import type { AssetWithOrigin } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";

export type CreateToolGrantsForPinsDeps = {
  /**
   * Resolves the `package-registry` assets a tenant sees, local first,
   * shadows-wins down the ancestor chain. The hub binds
   * `@intx/db`'s `listAssetsForTenant` to its own db handle.
   */
  listAssets: (
    tenantId: string,
    kind: string,
  ) => Promise<readonly AssetWithOrigin[]>;
  /** The launch-path asset service — the launch caches' SHA-keyed wrapper. */
  assetService: Pick<AssetService, "listAssetBlobs" | "readAssetBlob">;
};

export function createToolGrantsForPins(
  deps: CreateToolGrantsForPinsDeps,
): ToolGrantsForPins {
  return async (tenantId, pins) => {
    const assets = await deps.listAssets(tenantId, "package-registry");
    const registry = assets.find((row) => row.name === CORBITS_TOOLS_REGISTRY);
    if (registry === undefined) return [];

    const source: ToolSurfaceBlobSource = {
      listBlobs: (dir) =>
        deps.assetService.listAssetBlobs({ assetId: registry.id, dir }),
      readBlob: (path) =>
        deps.assetService.readAssetBlob({ assetId: registry.id, path }),
      rootDir: "tarballs",
    };
    const manifests = await readToolSurfaceManifests(source);
    const toolsByPackageName = new Map(
      manifests.map((manifest) => [
        manifest.name,
        manifest.surface.filter((entry) => entry.kind === "tool"),
      ]),
    );

    const grants: PinnedToolGrantDeclaration[] = [];
    for (const pin of pins) {
      const tools = toolsByPackageName.get(pin.name);
      if (tools === undefined) continue;
      for (const tool of tools) {
        grants.push({
          resource: `tool:${tool.qualifiedId}`,
          action: "invoke",
          effect: tool.approval === "ask" ? "ask" : "allow",
        });
      }
    }
    return grants;
  };
}
