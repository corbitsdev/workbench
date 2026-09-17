// The source form a catalog workflow deploys as when someone asks for it
// on demand — the instantiate path's block-workflow resolution
// (CL-6405) generalized to any catalog entry with a source package
// under `workflows/<name>` (CL-7073), not just `code-review`.
//
// Runtime wiring (CL-8113, hub-zero T2): the per-workflow `buildJson`
// closures (each one closing over its workflow package's trigger
// address and turn timeouts) live on this hub's own native
// `./catalog-blocks` `CATALOG_BLOCKS` entries, reached here through
// `deployableCatalogBlock` — the hub names no builder of its own, so
// the catalog's deployable set and the block sources served here can
// never drift apart silently. `assistant` (seeded, never redeployed
// here) and `heartbeat` (test-only, never deployed onto a real bench)
// are outside `CATALOG_BLOCKS`, so they answer `undefined` here, same
// as any name outside the catalog entirely — a route answering
// `undefined` as a 404 is the honest statement of that.
//
// Server-only, on purpose: each `buildJson` closure pulls in its
// workflow package (e.g. `@corbits/granola-call-workflow`) and with it
// `@intx/agent`/`@intx/workflow`. Only `./template-block-routes.ts`
// (mounted in `apps/hub`) imports this; it is deliberately not
// re-exported from the package root.
import { deployableCatalogBlock } from "./catalog-blocks";

export interface BlockWorkflowBuildInput {
  readonly tenantDomain: string;
  readonly inferencePreferences: readonly {
    readonly provider: string;
    readonly model: string;
  }[];
}

export interface BlockWorkflowSource {
  readonly assetName: string;
  readonly displayName: string;
  readonly workflowJson: string;
}

/**
 * The serialized source-form definition for one catalog workflow — or
 * `undefined` for `assistant`, `heartbeat`, and any name outside the
 * catalog. `buildJson` is a required field on every `CATALOG_BLOCKS`
 * entry, so a catalog name always answers here: the deployable set and
 * the served sources cannot drift apart silently.
 */
export function buildBlockWorkflowSource(
  assetName: string,
  input: BlockWorkflowBuildInput,
): BlockWorkflowSource | undefined {
  const workflow = deployableCatalogBlock(assetName);
  if (workflow === undefined) {
    return undefined;
  }
  return {
    assetName: workflow.assetName,
    displayName: workflow.displayName,
    workflowJson: workflow.buildJson(
      input.tenantDomain,
      input.inferencePreferences,
    ),
  };
}
