// The Tools page's reads and writes over the MCP servers a workbench holds.
// Adding or removing one changes what Myra carries, so every write ends in a
// redeploy: her definition's bindings are where a server actually takes effect.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { toAPIQuery, type APIQuery } from "@/lib/api-query";

import { isMyraAgent, listChatAgents } from "../chat/threads-api";
import { readAgentMcpHandles } from "../agent-source-read";
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  type AddMcpServerInput,
  type McpServer,
} from "../mcp-servers";
import { redeployWorkbenchAgent } from "../workbench-create";

/** A server plus the agents whose definitions bind it. */
export type McpServerRow = McpServer & { readonly agentNames: readonly string[] };

function mcpServersKey(tenantId: string | null) {
  return ["tenant", tenantId ?? "none", "tools", "mcp-servers"] as const;
}

/** An agent whose source can't be read carries nothing, rather than failing
 * the whole table. */
async function carriersByHandle(tenantId: string): Promise<Map<string, string[]>> {
  const agents = (await listChatAgents(tenantId)).filter((agent) => agent.liveAddress !== null);
  const byHandle = new Map<string, string[]>();
  await Promise.all(
    agents.map(async (agent) => {
      let handles: readonly string[] = [];
      try {
        handles = await readAgentMcpHandles(tenantId, agent.id, agent.assetName);
      } catch (error) {
        reportError(error, { operation: "mcp_servers_agent_bindings_read" });
        return;
      }
      for (const handle of handles) {
        byHandle.set(handle, [...(byHandle.get(handle) ?? []), agent.name]);
      }
    }),
  );
  return byHandle;
}

export function useMcpServers(tenantId: string | null): APIQuery<readonly McpServerRow[]> {
  const result = useQuery({
    queryKey: mcpServersKey(tenantId),
    enabled: tenantId !== null,
    queryFn: async () => {
      const id = tenantId as string;
      const [servers, carriers] = await Promise.all([listMcpServers(id), carriersByHandle(id)]);
      return servers.map((server) => ({
        ...server,
        agentNames: [...(carriers.get(server.handle) ?? [])].sort((a, b) => a.localeCompare(b)),
      }));
    },
  });
  return toAPIQuery(result);
}

/** Myra is the agent a workbench's servers are for, so she is the one the
 * write redeploys; nothing else needs to know a server was added. */
async function redeployMyra(tenantId: string): Promise<void> {
  const myra = (await listChatAgents(tenantId)).find(isMyraAgent);
  if (myra === undefined) return;
  await redeployWorkbenchAgent(tenantId, myra);
}

function useInvalidateTools(tenantId: string | null) {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: mcpServersKey(tenantId) }),
      client.invalidateQueries({
        queryKey: ["tenant", tenantId ?? "none", "tools", "deployed-packages"],
      }),
    ]);
  };
}

export function useAddMcpServer(tenantId: string | null) {
  const invalidate = useInvalidateTools(tenantId);
  return useMutation({
    mutationFn: async (input: Omit<AddMcpServerInput, "tenantId">) => {
      const id = tenantId as string;
      const server = await addMcpServer({ tenantId: id, ...input });
      await redeployMyra(id);
      return server;
    },
    onSettled: invalidate,
  });
}

export function useRemoveMcpServer(tenantId: string | null) {
  const invalidate = useInvalidateTools(tenantId);
  return useMutation({
    mutationFn: async (server: McpServer) => {
      const id = tenantId as string;
      await removeMcpServer({
        tenantId: id,
        credentialId: server.credentialId,
        providerId: server.providerId,
      });
      await redeployMyra(id);
    },
    onSettled: invalidate,
  });
}
