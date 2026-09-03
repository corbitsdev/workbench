// After a connector's credential lands, live assistants that already
// pin that connector's `feedsTools` packages still run the snapshot
// deployed at launch. Bindings for those packages
// (`pinnedPackageCredentialBindingsFor`) fold only at deploy, so a Myra
// launched at signup before Manus was pasted cannot `resolve("manus")`
// until this pass relaunches it. Persist-only (stamp the pin onto the
// launch row and leave the run) is the bug: the sidecar keeps the old
// snapshot.
import { CONNECTOR_REGISTRY } from "@corbits/connections/registry";

export type PinnedToolPackageReconcile = {
  reconcilePinnedToolPackages(
    tenantId: string,
    packageNames: readonly string[],
  ): Promise<{ scanned: number; relaunched: number }>;
};

/**
 * Relaunches live participants in `tenantId` whose pins include this
 * connector's `feedsTools`. Returns `undefined` when the connector
 * feeds no tool packages (inference-only, webhook, …).
 */
export async function reconcilePinnedToolPackagesAfterConnect(
  platform: PinnedToolPackageReconcile,
  info: { readonly tenantId: string; readonly connectorId: string },
): Promise<{ scanned: number; relaunched: number } | undefined> {
  const feedsTools = CONNECTOR_REGISTRY[info.connectorId]?.feedsTools ?? [];
  if (feedsTools.length === 0) return undefined;
  return platform.reconcilePinnedToolPackages(info.tenantId, feedsTools);
}
