// The write-side seam: wraps a `SessionService & AdoptingWorkflowDeployer`
// so every code-sourced workflow deploy on SHARED capacity -- the only
// placement whose source previously existed nowhere in Postgres -- durably
// records its `WorkflowDefinitionSource` before returning to the caller.
//
// This is a workbench-side decorator around `@intx/hub-sessions`'
// `createSessionService(...)` output, composed at the app root
// (apps/hub/src/index.ts) exactly where `createLaunchCaches` already wraps
// `repoStore`/`assetService` the same way -- never a change to
// vendor/intx/hub-sessions/src/session-service.ts, whose two deploy methods
// this only wraps, not reimplements. Exclusive placement is unaffected: it
// already persists its source durably via `workflow_run_launch_spec`
// (vendor/intx/db/src/schema/workflow-run-launch-spec.ts), written from
// vendored `workflow-allocation-service.ts`, which this package does not
// touch.
import { getLogger } from "@intx/log";
import type {
  AdoptingWorkflowDeployer,
  DeployAdoptedWorkflowFromSourceParams,
  DeployWorkflowFromSourceParams,
  SessionService,
} from "@intx/hub-sessions";

import type { WorkflowDeploySourceStore } from "./store";

const logger = getLogger(["workflow-deploy-source", "record-on-deploy"]);

export type DeployWorkflowDeployer = SessionService & AdoptingWorkflowDeployer;

function recordFromDeployParams(
  params:
    DeployWorkflowFromSourceParams | DeployAdoptedWorkflowFromSourceParams,
) {
  return {
    anchorRunId: params.anchorRunId,
    tenantId: params.tenantId,
    deploymentDomain: params.deploymentDomain,
    source: params.source,
    entry: params.entry,
    definitionAssetId: params.definitionAssetId,
    sourceAuthorityPrincipalId: params.config.principalId,
    ...(params.pin !== undefined ? { pin: params.pin } : {}),
    ...(params.sourceRef !== undefined ? { sourceRef: params.sourceRef } : {}),
  };
}

/**
 * Wrap a session service so `deployWorkflowFromSource` and
 * `deployAdoptedWorkflowFromSource` -- the shared-capacity code-sourced
 * deploy entry points `POST /workflows/deployments` and the routine
 * launcher's adopted-anchor deploy drive -- record their `source` durably
 * AFTER the deploy itself succeeds. A recording failure is reported (never
 * a bare catch) but does not fail the deploy: the sidecar agent is already
 * live by the time this runs, so surfacing the recording failure as a
 * deploy failure would strand a live deployment behind a 500.
 */
export function withDeploySourceRecording<T extends DeployWorkflowDeployer>(
  sessionService: T,
  store: WorkflowDeploySourceStore,
): T {
  return {
    ...sessionService,
    async deployWorkflowFromSource(params) {
      const result = await sessionService.deployWorkflowFromSource(params);
      await recordOrLog(store, recordFromDeployParams(params));
      return result;
    },
    async deployAdoptedWorkflowFromSource(params) {
      const result =
        await sessionService.deployAdoptedWorkflowFromSource(params);
      await recordOrLog(store, recordFromDeployParams(params));
      return result;
    },
  };
}

async function recordOrLog(
  store: WorkflowDeploySourceStore,
  entry: ReturnType<typeof recordFromDeployParams>,
): Promise<void> {
  try {
    await store.record(entry);
  } catch (cause) {
    logger.error`failed to record deploy source for anchor run ${entry.anchorRunId}: ${
      cause instanceof Error ? cause.message : String(cause)
    }`;
  }
}
