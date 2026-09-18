// Notifications have no backing feature in the hub, so nothing is fetched
// for them — the column renders an honest empty state instead.

import { useQuery } from "@tanstack/react-query";
import { listWorkbenches, type Workbench } from "@/chat/workbench-tenants";

import { listAgentDefinitions, type AgentDefinition } from "../agents-api";
import { tenantKeys } from "../query-client";
import { listRoutineActivity } from "./routine-activity";
import type { RoutineActivityItem } from "./routine-activity";

export type BenchActivityQuery =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly workbenches: readonly Workbench[];
      readonly chats: readonly Workbench[];
      readonly agents: readonly AgentDefinition[];
      readonly routines: readonly RoutineActivityItem[];
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
    queryKey: tenantKeys.workbenches(key, "workbench"),
    enabled,
    queryFn: () => listWorkbenches(key, "workbench"),
  });
  const chatsQuery = useQuery({
    queryKey: tenantKeys.workbenches(key, "chat"),
    enabled,
    queryFn: () => listWorkbenches(key, "chat"),
  });
  const routinesQuery = useQuery({
    queryKey: tenantKeys.routineActivity(key),
    enabled,
    queryFn: () => listRoutineActivity(),
  });
  const agentsQuery = useQuery({
    queryKey: tenantKeys.visibleAgents(key),
    enabled,
    queryFn: () => listAgentDefinitions(key),
  });

  if (tenantId === null) return { kind: "empty" };

  for (const query of [workbenchesQuery, chatsQuery, routinesQuery, agentsQuery]) {
    if (query.isError) return { kind: "error", message: errorMessage(query.error) };
  }
  if (
    workbenchesQuery.data === undefined ||
    chatsQuery.data === undefined ||
    routinesQuery.data === undefined ||
    agentsQuery.data === undefined
  ) {
    return { kind: "loading" };
  }

  return {
    kind: "ready",
    workbenches: workbenchesQuery.data,
    chats: chatsQuery.data,
    agents: agentsQuery.data,
    routines: routinesQuery.data,
  };
}
