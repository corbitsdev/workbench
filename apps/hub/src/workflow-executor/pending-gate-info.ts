import { getLogger } from "@intx/log";
import type { RepoStore } from "@workbench/hub-sessions";

import { getAwaitingSignalNames } from "./run-awaiting-signals";
import { describeResumePayload } from "./resume-payload-registry";

const log = getLogger(["workflow-exec", "pending-gate-info"]);

export type PendingGate = { signalName: string; payloadSchema?: string };

export async function describePendingGates(
  deps: { repoStore: RepoStore; deploymentDomain: string },
  run: { runId: string; kind: string; deploymentId: string },
): Promise<PendingGate[]> {
  try {
    const open = await getAwaitingSignalNames(
      { repoStore: deps.repoStore },
      {
        deploymentId: run.deploymentId,
        runId: run.runId,
        deploymentDomain: deps.deploymentDomain,
      },
    );
    return [...open].sort().map((signalName) => {
      const payloadSchema = describeResumePayload(run.kind, signalName);
      return payloadSchema === undefined
        ? { signalName }
        : { signalName, payloadSchema };
    });
  } catch (err) {
    log.warn("pending gate describe: run log unreadable", {
      runId: run.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
