// The tenant's tool roster, read off what its agents actually carry rather
// than a registry that outlives the packages it once held. An agent's tool
// packages live in two places: pinned in its deployed `definition.json`
// (`readAgentToolPackagePins`), or — for Myra — bundled straight into her
// `workflow.js` closure, which never shows up in that file (see
// `MYRA_TOOL_PACKAGES`).

import { useQuery } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";
import { MYRA_TOOL_PACKAGES } from "@corbits/myra/tool-packages";

import { toAPIQuery, type APIQuery } from "@/lib/api-query";

import { isMyraAgent, listChatAgents, type ChatAgent } from "../chat/threads-api";
import { readAgentToolPackagePins } from "../agent-source-read";

export type DeployedToolPackage = {
  readonly name: string;
  readonly version: string | null;
  /** Agents carrying this package, by display name, deduped and sorted. */
  readonly agentNames: readonly string[];
};

function liveAgentsOf(agents: readonly ChatAgent[]): readonly ChatAgent[] {
  return agents.filter((agent) => agent.liveAddress !== null);
}

async function toolPackagesOf(
  tenantId: string,
  agent: ChatAgent,
): Promise<readonly { readonly name: string; readonly version: string | null }[]> {
  if (isMyraAgent(agent)) return MYRA_TOOL_PACKAGES;
  try {
    return await readAgentToolPackagePins(tenantId, agent.id, agent.assetName);
  } catch (error) {
    reportError(error, { operation: "deployed_tool_packages_read" });
    return [];
  }
}

/** Every tool package carried by one of the tenant's live agent deployments,
 * grouped by package name and joined against which agents carry it. An
 * agent whose definition can't be read contributes nothing rather than
 * failing the whole roster. */
async function listDeployedToolPackages(tenantId: string): Promise<readonly DeployedToolPackage[]> {
  const agents = liveAgentsOf(await listChatAgents(tenantId));
  const perAgent = await Promise.all(
    agents.map(async (agent) => ({ agent, packages: await toolPackagesOf(tenantId, agent) })),
  );

  const byName = new Map<string, { version: string | null; agentNames: Set<string> }>();
  for (const { agent, packages } of perAgent) {
    for (const pkg of packages) {
      const entry = byName.get(pkg.name) ?? { version: pkg.version, agentNames: new Set() };
      entry.agentNames.add(agent.name);
      byName.set(pkg.name, entry);
    }
  }

  return [...byName.entries()]
    .map(([name, { version, agentNames }]) => ({
      name,
      version,
      agentNames: [...agentNames].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The tenant's deployed tool packages, for the Tools page. */
export function useDeployedToolPackages(
  tenantId: string | null,
): APIQuery<readonly DeployedToolPackage[]> {
  const result = useQuery({
    queryKey: ["tenant", tenantId ?? "none", "tools", "deployed-packages"] as const,
    enabled: tenantId !== null,
    queryFn: () => listDeployedToolPackages(tenantId as string),
  });
  return toAPIQuery(result);
}
