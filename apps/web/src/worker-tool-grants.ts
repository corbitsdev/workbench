// The worker's live run principal grants, shared by the worker page and the
// role line.

import { listTopLevelRuns } from "./agents-api";
import type { ChatAgent } from "./chat/threads-api";
import { tenantKeys } from "./query-client";
import { listGrants, listPrincipals } from "./settings/tenancy-api";
import { applyGrantSnapshot } from "./worker-grants-carry";

export function workerToolGrantsKey(tenantId: string, agentId: string) {
  return [...tenantKeys.grants(tenantId), "worker", agentId] as const;
}

export const TOOL_PREFIX = "tool:";

/** The worker's live run principal: runtime grants belong to it, and it only
 * exists once the worker has been triggered. */
export async function readWorkerToolGrants(tenantId: string, agent: ChatAgent) {
  if (agent.liveAddress === null) return null;
  const [runs, principals] = await Promise.all([
    listTopLevelRuns(tenantId),
    listPrincipals(tenantId),
  ]);
  const run = runs.find((candidate) => candidate.address === agent.liveAddress);
  const principal = principals.find(
    (candidate) => candidate.kind === "workflow" && candidate.refId === run?.id,
  );
  if (principal === undefined) return null;
  const read = async () => {
    const grants = await listGrants(tenantId, { principalId: principal.id });
    return grants
      .filter((grant) => grant.resource.startsWith(TOOL_PREFIX) && grant.action === "invoke")
      .sort((a, b) => a.resource.localeCompare(b.resource));
  };
  let tools = await read();
  if (await applyGrantSnapshot(tenantId, agent.assetName, principal.id, tools)) {
    tools = await read();
  }
  return { principalId: principal.id, tools };
}
