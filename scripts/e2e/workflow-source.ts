// Publishing a workflow definition as a `workflow`-kind asset — split out
// of harness.ts because both helpers below need `@corbits/seeding` and
// `@corbits/workflows`, which pull in the full `@intx/*` module graph.
// Most harness consumers (spawning the hub/sidecar, calling its HTTP
// API) never touch these two; keeping them here means importing
// harness.ts no longer pays that load cost on their behalf.
import { createGitWorkflowPusher } from "../../packages/seeding/src/index.ts";
import { WORKFLOW_SOURCE_ENTRY } from "../../packages/workflows/src/source.ts";

/**
 * Publishes a workflow definition into its asset repo in the one shape
 * a `workflow`-kind asset accepts: the source codebase
 * `@corbits/workflows`'s `./source` renders. Delegates to the platform's own
 * pusher so the suite exercises the same publication path the seed and
 * the product use, and returns the commit a code-sourced deploy pins.
 */
export async function pushWorkflowSource(options: {
  baseUrl: string;
  tenantId: string;
  assetName: string;
  tokenSecret: string;
  workflowJson: string;
}): Promise<{ commitSha: string }> {
  const pushed = await createGitWorkflowPusher()({
    remoteUrl: `${options.baseUrl}/api/tenants/${options.tenantId}/assets/workflow/${options.assetName}.git`,
    tokenSecret: options.tokenSecret,
    workflowJson: options.workflowJson,
    packageName: options.assetName,
  });
  return { commitSha: pushed.commitSha };
}

/**
 * The deploy body a code-sourced asset deployment takes: the pushed
 * commit is the definition's pin, and the entry names the
 * `interchange.workflow` module the sidecar evaluates. The native route
 * resolves inference against the tenant's own catalog, so the caller
 * supplies the ordered catalog offering ids to deploy against rather
 * than a raw provider/baseURL/apiKey triple — see
 * `@corbits/seeding`'s `ensureNoopCatalogOffering` for the zero-cost way
 * to obtain one.
 */
export function workflowDeployBody(options: {
  assetId: string;
  commitSha: string;
  sourceOfferingIds: string[];
  defaultSourceOfferingId: string;
}): Record<string, unknown> {
  return {
    source: {
      kind: "asset",
      assetId: options.assetId,
      package: { format: "source", commitSha: options.commitSha },
    },
    entry: WORKFLOW_SOURCE_ENTRY,
    sourceOfferingIds: options.sourceOfferingIds,
    defaultSourceOfferingId: options.defaultSourceOfferingId,
  };
}
