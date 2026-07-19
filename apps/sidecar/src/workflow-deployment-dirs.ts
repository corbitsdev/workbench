import { rm } from "node:fs/promises";
import { join as pathJoin } from "node:path";

/**
 * A deployment's on-disk root under the sidecar data dir: the workflow-run
 * substrate (event logs, step scratch) for one deployment. Exported so a
 * teardown that has no in-memory supervisor (and therefore no `ownedDirs` to
 * sweep) can reclaim the whole directory directly.
 *
 * The sidecar keeps NO deployment memory beyond this durable run state
 * (CL-3884): there is no boot restore, no `deployment.json` record, no
 * dormant marker, no tombstone. The hub is the control plane — it re-deploys
 * what should be resident (mail-wake for idle agents, gate signals +
 * awaiting prewarm for parked runs, the liveness sweep fails running runs
 * whose child died) — so a freshly-booted sidecar is empty by design.
 */
export function workflowDeploymentDir(
  dataDir: string,
  deploymentId: string,
): string {
  return pathJoin(dataDir, "workflow-runs", deploymentId);
}

/**
 * Reclaim a deployment's entire on-disk directory (workflow-run substrate +
 * any residue). Idempotent (`force`): a missing directory is not an error.
 */
export async function reclaimWorkflowDeploymentDir(
  dataDir: string,
  deploymentId: string,
): Promise<void> {
  await rm(workflowDeploymentDir(dataDir, deploymentId), {
    recursive: true,
    force: true,
  });
}
