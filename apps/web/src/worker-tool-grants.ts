// The worker's live run principal grants, shared by the worker page and the
// role line.

import { listTopLevelRuns } from "./agents-api";
import type { ChatAgent } from "./chat/threads-api";
import { tenantKeys } from "./query-client";
import { listGrants, listPrincipals, type Grant } from "./settings/tenancy-api";
import type { ToolEffect } from "./agent-deploy";

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
  const grants = await listGrants(tenantId, { principalId: principal.id });
  const tools = grants
    .filter((grant) => grant.resource.startsWith(TOOL_PREFIX) && grant.action === "invoke")
    .sort((a, b) => a.resource.localeCompare(b.resource));
  return { principalId: principal.id, tools };
}

const EFFECT_RANK = { allow: 0, ask: 1, deny: 2 } as const;

/** One row per tool resource, carrying the effect that wins at runtime
 * (deny over ask over allow): a redeploy's requirement can sit beside the
 * tool's own floor row, and the stronger one decides. */
export function effectiveToolGrants(tools: readonly Grant[]): readonly Grant[] {
  const byResource = new Map<string, Grant>();
  for (const grant of tools) {
    const held = byResource.get(grant.resource);
    if (held === undefined || EFFECT_RANK[grant.effect] > EFFECT_RANK[held.effect]) {
      byResource.set(grant.resource, grant);
    }
  }
  return [...byResource.values()];
}

/** The non-ask tool effects to re-declare on a redeploy. */
export function toolEffectsToCarry(tools: readonly Grant[]): readonly ToolEffect[] {
  return effectiveToolGrants(tools).flatMap((grant) =>
    grant.effect === "ask" ? [] : [{ resource: grant.resource, effect: grant.effect }],
  );
}
