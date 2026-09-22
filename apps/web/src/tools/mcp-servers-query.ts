// The Tools page's reads and writes over the workspace MCP catalog. The
// catalog lives once on the workspace (top-level) tenant regardless of which
// workbench is selected; adding or removing a server changes what every
// workbench Myra carries, so every write ends in a redeploy of each Myra
// whose binding list changed, and the page says how many.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { describeApiError, toAPIQuery, type APIQuery } from "@/lib/api-query";

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
export type RedeployFailure = {
  /** The tenant whose Myra did not come back. */
  readonly tenantId: string;
  /** The workbench name the Tools page can show, so a stale Myra is named. */
  readonly workbenchName: string;
  /** User-safe copy: status-derived, never a raw path or schema summary. */
  readonly error: string;
};

export type RedeployWorkspaceResult = {
  readonly redeployed: number;
  readonly failed: readonly RedeployFailure[];
};

type MyraRef = { readonly id: string; readonly name: string; readonly assetName: string };

/** The per-workbench loop behind `redeployWorkspaceMyras`, factored for
 * test: one workbench's failure never stops the rest — the catalog write
 * already landed, so failures come back named instead of failing the whole
 * mutation. */
export async function redeployMyraTenants(
  tenants: readonly { readonly id: string; readonly name: string }[],
  deps: {
    readonly findMyra: (tenantId: string) => Promise<MyraRef | undefined>;
    readonly redeploy: (tenantId: string, myra: MyraRef) => Promise<void>;
  },
): Promise<RedeployWorkspaceResult> {
  let redeployed = 0;
  const failed: RedeployFailure[] = [];
  for (const tenant of tenants) {
    let myra: MyraRef | undefined;
    try {
      myra = await deps.findMyra(tenant.id);
    } catch (cause) {
      failed.push({
        tenantId: tenant.id,
        workbenchName: tenant.name,
        error: describeApiError(cause, "reaching this workbench"),
      });
      continue;
    }
    if (myra === undefined) continue;
    try {
      await deps.redeploy(tenant.id, myra);
      redeployed += 1;
    } catch (cause) {
      failed.push({
        tenantId: tenant.id,
        workbenchName: tenant.name,
        error: describeApiError(cause, "redeploying Myra"),
      });
    }
  }
  return { redeployed, failed };
}

/** One line the Tools page can toast after a catalog write: the count, plus
 * the names a failed redeploy left stale. */
export function describeRedeployResult(result: RedeployWorkspaceResult): string {
  const count = `${String(result.redeployed)} ${result.redeployed === 1 ? "workbench" : "workbenches"}`;
  if (result.failed.length === 0) return `Myra redeployed in ${count}.`;
  const names = result.failed.map((failure) => failure.workbenchName).join(", ");
  return (
    `Myra redeployed in ${count}, but the redeploy failed in ${names} — ` +
    `those workbenches still run the old catalog. Try the change again.`
  );
}

async function redeployWorkspaceMyras(workspaceTenantId: string): Promise<RedeployWorkspaceResult> {
  const workbenches = await listWorkbenchTenants(workspaceTenantId);
  const result = await redeployMyraTenants(
    [
      { id: workspaceTenantId, name: "workspace" },
      ...workbenches.map((workbench) => ({ id: workbench.id, name: workbench.title })),
    ],
    {
      findMyra: async (tenantId) => (await listChatAgents(tenantId)).find(isMyraAgent),
      redeploy: (tenantId, myra) => redeployWorkbenchAgent(tenantId, myra),
    },
  );
  for (const failure of result.failed) {
    reportError(new Error(`redeploying Myra in ${failure.tenantId} failed`), {
      operation: "mcp_servers_redeploy",
    });
  }
  return result;
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
  /** The workbenches whose redeploy failed — the catalog write already
   * landed, so these still run the old one. */
  readonly failed: readonly RedeployFailure[];
};

export function useAddMcpServer(tenantId: string | null) {
  const invalidate = useInvalidateTools(tenantId);
  return useMutation({
    mutationFn: async (input: Omit<AddMcpServerInput, "tenantId">): Promise<AddMcpServerResult> => {
      const id = tenantId as string;
      const workspaceTenantId = await resolveWorkspaceTenantId(id);
      const server = await addMcpServer({ tenantId: workspaceTenantId, ...input });
      const redeployed = await redeployWorkspaceMyras(workspaceTenantId);
      return { server, ...redeployed };
    },
    onSettled: invalidate,
  });
}

export type RemoveMcpServerResult = {
  /** How many workbench Myras were redeployed without the server. */
  readonly redeployed: number;
  /** The workbenches whose redeploy failed — the removal already landed,
   * so these still run the old catalog. */
  readonly failed: readonly RedeployFailure[];
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
      return redeployWorkspaceMyras(workspaceTenantId);
    },
    onSettled: invalidate,
  });
}
