import type { WorkbenchParticipant } from "./threads-api";

type RedeployableAgent = WorkbenchParticipant & { readonly assetName: string };

function withMode(mode: "auto" | "manual") {
  return (agent: WorkbenchParticipant): agent is RedeployableAgent =>
    agent.kind === "agent" && agent.assetName !== undefined && agent.redeploy === mode;
}

export function agentsToAutoDeploy(agents: readonly WorkbenchParticipant[]): RedeployableAgent[] {
  return agents.filter(withMode("auto"));
}

export function stoppedAgents(agents: readonly WorkbenchParticipant[]): RedeployableAgent[] {
  return agents.filter(withMode("manual"));
}
