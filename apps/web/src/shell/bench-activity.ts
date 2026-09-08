// The sidebar's one data source: everything happening in the currently
// selected bench right now. Workbenches and chats come from
// `@corbits/chat-ui`'s own validated fetches; running routines come through
// the seam in `./routine-activity.ts`. Notifications have no backing
// feature in the hub yet, so they are not fetched here at all — the
// column renders an honest empty state for that section instead of a
// query with nowhere to point.
//
// `useBenchActivity` may be mounted more than once per navigation (the
// sidebar's `WorkbenchList` in `./workbench-list.tsx`), so every listing
// below goes through `useQuery` keyed with the shared `tenantKeys`
// factories — both mounts subscribe to the same cached queries instead of
// each firing its own fetch. This uses `useQuery` directly rather than the
// app's `useTenantQuery` wrapper because that wrapper's `toAPIQuery` maps a
// failure onto generic copy; this band shows the real error text instead
// (the mock's error states are diagnostic, not decorative).

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  WORKBENCHES_MUTATED_EVENT,
  workbenchesQueryKeyPrefix,
  listWorkbenches,
  listVisibleAgentDefinitions,
} from "@corbits/chat-ui";
import type { Workbench, VisibleAgentDefinition } from "@corbits/chat-ui";

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
      readonly agents: readonly VisibleAgentDefinition[];
      readonly routines: readonly RoutineActivityItem[];
    };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Bench-scoped live activity for the second column, refetched whenever the
 * selected bench changes — nothing here is page-scoped, so a route change
 * alone never triggers a refetch. */
export function useBenchActivity(tenantId: string | null): BenchActivityQuery {
  const enabled = tenantId !== null;
  const key = tenantId ?? "";
  const queryClient = useQueryClient();

  // A conversation minted anywhere (picker dialog, agent launch, the
  // land-hop) announces itself via `WORKBENCHES_MUTATED_EVENT`; without
  // this, the sidebar's cached listing only catches up on the next
  // unrelated refetch and a fresh workbench is invisible until then.
  useEffect(() => {
    const onMutated = (event: Event) => {
      const detail = (event as CustomEvent<{ tenantId?: string }>).detail;
      if (detail?.tenantId === undefined) return;
      void queryClient.invalidateQueries({
        queryKey: workbenchesQueryKeyPrefix(detail.tenantId),
      });
    };
    window.addEventListener(WORKBENCHES_MUTATED_EVENT, onMutated);
    return () =>
      window.removeEventListener(WORKBENCHES_MUTATED_EVENT, onMutated);
  }, [queryClient]);

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
    queryKey: tenantKeys.topLevelRuns(key),
    enabled,
    queryFn: () => listRoutineActivity(key),
  });
  const agentsQuery = useQuery({
    queryKey: tenantKeys.visibleAgents(key),
    enabled,
    queryFn: () => listVisibleAgentDefinitions(key),
  });

  if (tenantId === null) return { kind: "empty" };

  for (const query of [
    workbenchesQuery,
    chatsQuery,
    routinesQuery,
    agentsQuery,
  ]) {
    if (query.isError)
      return { kind: "error", message: errorMessage(query.error) };
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
