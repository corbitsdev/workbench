import type { WorkflowDeploymentResponse, WorkflowRunStatus } from "@intx/types";

export type DeploymentLiveness = "live" | "starting" | "stopped";

const DEAD_RUN_STATUSES = new Set<WorkflowRunStatus>(["error", "stopped"]);

/** The deployments projection never consults run status, so a dead run still
 * reads "deployed"; the run's own status settles it. */
export function deploymentLiveness(
  deploymentStatus: WorkflowDeploymentResponse["status"],
  runStatus: WorkflowRunStatus | undefined,
): DeploymentLiveness {
  if (runStatus !== undefined && DEAD_RUN_STATUSES.has(runStatus)) return "stopped";
  if (deploymentStatus === "deployed") return "live";
  if (deploymentStatus === "pending" || deploymentStatus === "recovering") return "starting";
  return "stopped";
}

const QUICK_DEATH_MS = 2 * 60 * 1000;

/** A run that ended within moments of starting: redeploying it again would
 * only loop, so the person restarts it instead. */
export function diedQuickly(run: {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string | null;
}): boolean {
  const end = Date.parse(run.endedAt ?? run.updatedAt);
  return end - Date.parse(run.createdAt) < QUICK_DEATH_MS;
}

export type RedeployMode = "auto" | "manual";
export type WorkerState = "live" | "starting" | "stopped";

type AgentLiveness = {
  readonly liveAddress: string | null;
  readonly latest: DeploymentLiveness;
  readonly capped: boolean;
};

/** What happens to a worker with nothing live: a dead one redeploys on its
 * own once, then, if that died again quickly, waits for the person. */
export function redeployMode(agent: AgentLiveness): RedeployMode | undefined {
  if (agent.liveAddress !== null || agent.latest !== "stopped") return undefined;
  return agent.capped ? "manual" : "auto";
}

/** The one worker state every surface reads. */
export function workerState(agent: AgentLiveness): WorkerState {
  if (agent.liveAddress !== null) return "live";
  return redeployMode(agent) === "manual" ? "stopped" : "starting";
}
