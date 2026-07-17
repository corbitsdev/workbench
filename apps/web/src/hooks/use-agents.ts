import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import { api } from "../lib/api";

export const AgentInstanceWireSchema = type({
  id: "string",
  agentId: "string",
  agentName: "string",
  agentDescription: "string | null",
  tenantId: "string",
  address: "string",
  status: "string",
});

export const AgentInstancesResponseSchema = type({
  data: AgentInstanceWireSchema.array(),
});

export type AgentInstanceItem = {
  id: string;
  agentId: string;
  name: string;
  description: string | null;
  tenantId: string;
  address: string;
  status: string;
};

function toAgentInstanceItem(
  wire: typeof AgentInstanceWireSchema.infer,
): AgentInstanceItem {
  return {
    id: wire.id,
    agentId: wire.agentId,
    name: wire.agentName,
    description: wire.agentDescription,
    tenantId: wire.tenantId,
    address: wire.address,
    status: wire.status,
  };
}

export function useAgentInstances(tenantId: string | null) {
  return useQuery<AgentInstanceItem[]>({
    queryKey: ["agent-instances", tenantId],
    queryFn: async () => {
      if (tenantId === null) throw new Error("tenantId is required");
      const raw = await api<unknown>(
        "GET",
        `/agents?tenantId=${encodeURIComponent(tenantId)}`,
      );
      const parsed = AgentInstancesResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected agents response: ${parsed.summary}`);
      }
      return parsed.data.map(toAgentInstanceItem);
    },
    enabled: tenantId !== null,
    staleTime: 5 * 60_000,
  });
}
