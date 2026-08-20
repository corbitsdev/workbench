// Boot restore spawns each restored deployment's supervisor BEFORE
// `hubLink.connect()`, and a supervisor that finds a run whose step died
// mid-invocation commits that run's `StepFailed`/`RunFailed` immediately.
// Those commits schedule a workflow-run pack push into a link that does not
// exist yet, so the push fails "Connection lost" and its only recovery is the
// post-challenge re-drive, which re-ships a slot whose error has already
// latched. When the rejection lands AFTER the challenge fired, nothing
// re-arms the slot: the terminal event stays on sidecar disk, the hub's copy
// of the durable log stops at the last pre-crash event, and
// `workflow_run.status` stays "running" for a run that will never accept mail
// again.
//
// Holding every address registered during boot restore until the reconnect
// challenge proves it routable removes the race rather than recovering from
// it — the same block the link already applies across a mid-life disconnect.
import type { WorkflowRunPackPushingRepoStore } from "./workflow-run-pack-client";

export interface BootRestorePushHold {
  /** Arm the hold for the duration of `restoreWorkflowDeployments`. */
  begin(): void;
  /** Disarm it; deployments registered afterwards arrive over a live link. */
  end(): void;
  /** Called for every deployment registration the deploy router makes. */
  onDeploymentRegistered(agentAddress: string): void;
}

export function createBootRestorePushHold(
  store: Pick<WorkflowRunPackPushingRepoStore, "markAddressUnroutable">,
): BootRestorePushHold {
  let restoring = false;
  return {
    begin() {
      restoring = true;
    },
    end() {
      restoring = false;
    },
    onDeploymentRegistered(agentAddress) {
      if (!restoring) return;
      store.markAddressUnroutable(agentAddress);
    },
  };
}
