// Notifications have no backing feature in the hub, so nothing is fetched
// for them — the column renders an honest empty state instead.

import { useQuery } from "@tanstack/react-query";
import { listWorkbenches, type Workbench } from "@/chat/workbench-tenants";

import { listAgentDefinitions, type AgentDefinition } from "../agents-api";
import { tenantKeys } from "../query-client";

export type BenchActivityQuery =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly workbenches: readonly Workbench[];
      readonly agents: readonly AgentDefinition[];
    };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Bench-scoped live activity for the second column, refetched whenever
 * the selected bench changes — nothing here is page-scoped, so a route
 * change alone never triggers a refetch. */
export function useBenchActivity(tenantId: string | null): BenchActivityQuery {
  const enabled = tenantId !== null;
  const key = tenantId ?? "";

  const workbenchesQuery = useQuery({
    queryKey: tenantKeys.workbenches(key),
    enabled,
    queryFn: () => listWorkbenches(key),
  });
  const agentsQuery = useQuery({
    queryKey: tenantKeys.visibleAgents(key),
    enabled,
    queryFn: () => listAgentDefinitions(key),
  });

  if (tenantId === null) return { kind: "empty" };

  for (const query of [workbenchesQuery, agentsQuery]) {
    if (query.isError) return { kind: "error", message: errorMessage(query.error) };
  }
  if (workbenchesQuery.data === undefined || agentsQuery.data === undefined) {
    return { kind: "loading" };
  }

  return {
    kind: "ready",
    workbenches: workbenchesQuery.data,
    agents: agentsQuery.data,
  };
}
