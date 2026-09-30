import { useQuery } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { isMyraAgent, type ChatAgent } from "./chat/threads-api";
import { readAgentMcpHandles } from "./agent-source-read";
import { tenantKeys } from "./query-client";
import { workerRole } from "./worker-role";
import { TOOL_PREFIX, readWorkerToolGrants, workerToolGrantsKey } from "./worker-tool-grants";

/** The role line for a worker, from its bound MCP servers and its run's
 * `tool:*` grants. Until both land it reads as no tools yet. */
export function useWorkerRole(tenantId: string, agent: ChatAgent): string {
  const isMyra = isMyraAgent(agent);
  const grants = useQuery({
    queryKey: workerToolGrantsKey(tenantId, agent.id),
    queryFn: () => readWorkerToolGrants(tenantId, agent),
    enabled: !isMyra,
  });
  const handles = useQuery({
    queryKey: [...tenantKeys.agents(tenantId), "mcp-handles", agent.id],
    queryFn: async () => {
      try {
        return await readAgentMcpHandles(tenantId, agent.id, agent.assetName);
      } catch (error) {
        reportError(error, { operation: "worker_role_mcp_handles_read" });
        return [];
      }
    },
    enabled: !isMyra,
  });
  return workerRole({
    isMyra,
    tools: (grants.data?.tools ?? []).map((grant) => grant.resource.slice(TOOL_PREFIX.length)),
    mcpServers: handles.data ?? [],
  });
}
