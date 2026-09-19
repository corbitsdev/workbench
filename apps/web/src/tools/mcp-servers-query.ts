// The Tools page's reads and writes over the workspace MCP catalog. The
// catalog lives once on the workspace (top-level) tenant regardless of which
// workbench is selected; adding or removing a server changes what every
// workbench Myra carries, so every write ends in a redeploy of each Myra
// whose binding list changed, and the page says how many.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { toAPIQuery, type APIQuery } from "@/lib/api-query";

import { isMyraAgent, listChatAgents } from "../chat/threads-api";
import { listWorkbenchTenants } from "../chat/workbench-tenants";
import { readAgentMcpHandles } from "../agent-source-read";
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  resolveWorkspaceTenantId,
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
      const workspaceTenantId = await resolveWorkspaceTenantId(id);
      const [servers, carriers] = await Promise.all([
        listMcpServers(workspaceTenantId),
        carriersByHandle(id),
      ]);
      return servers.map((server) => ({
        ...server,
        agentNames: [...(carriers.get(server.handle) ?? [])].sort((a, b) => a.localeCompare(b)),
      }));
    },
  });
  return toAPIQuery(result);
}

/** Myra binds the whole workspace catalog, so any catalog change alters her
 * binding list in every workbench. Redeploys the workspace's own Myra and
 * each child workbench's, and returns how many were redeployed. */
async function redeployWorkspaceMyras(workspaceTenantId: string): Promise<number> {
  const workbenches = await listWorkbenchTenants(workspaceTenantId);
  const tenantIds = [workspaceTenantId, ...workbenches.map((workbench) => workbench.id)];
  let redeployed = 0;
  for (const tenantId of tenantIds) {
    const myra = (await listChatAgents(tenantId)).find(isMyraAgent);
    if (myra === undefined) continue;
    await redeployWorkbenchAgent(tenantId, myra);
    redeployed += 1;
  }
  return redeployed;
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

export type AddMcpServerResult = {
  readonly server: McpServer;
  /** How many workbench Myras were redeployed with the new catalog. */
  readonly redeployed: number;
};

export function useAddMcpServer(tenantId: string | null) {
  const invalidate = useInvalidateTools(tenantId);
  return useMutation({
    mutationFn: async (input: Omit<AddMcpServerInput, "tenantId">): Promise<AddMcpServerResult> => {
      const id = tenantId as string;
      const workspaceTenantId = await resolveWorkspaceTenantId(id);
      const server = await addMcpServer({ tenantId: workspaceTenantId, ...input });
      const redeployed = await redeployWorkspaceMyras(workspaceTenantId);
      return { server, redeployed };
    },
    onSettled: invalidate,
  });
}

export type RemoveMcpServerResult = {
  /** How many workbench Myras were redeployed without the server. */
  readonly redeployed: number;
};

export function useRemoveMcpServer(tenantId: string | null) {
  const invalidate = useInvalidateTools(tenantId);
  return useMutation({
    mutationFn: async (server: McpServer): Promise<RemoveMcpServerResult> => {
      const id = tenantId as string;
      const workspaceTenantId = await resolveWorkspaceTenantId(id);
      await removeMcpServer({
        tenantId: workspaceTenantId,
        credentialId: server.credentialId,
        providerId: server.providerId,
      });
      const redeployed = await redeployWorkspaceMyras(workspaceTenantId);
      return { redeployed };
    },
    onSettled: invalidate,
  });
}
