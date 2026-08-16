// The sidebar's one data source: everything happening in the currently
// selected bench right now. Channels and chats come from
// `@corbits/chat-ui`'s own validated fetches; running routines come through
// the seam in `./routine-activity.ts`; the signed-in user's in-progress
// tasks come from `@corbits/tasks-ui` (`GET /tasks` is already
// creator-scoped, so every task here is already "mine" — see
// `packages/tasks/src/routes.ts`). Each task carries its own `agentName`
// (set at launch time, see `packages/tasks/src/schema.ts`), so this hook
// never has to cross-reference a definitions listing to name a row — that
// listing excludes planner-created agents (CL-6051), which would have
// left their tasks with no name to show. Notifications have no backing
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
  CHANNELS_MUTATED_EVENT,
  channelsQueryKeyPrefix,
  listChannels,
} from "@corbits/chat-ui";
import type { Channel } from "@corbits/chat-ui";
import { listTasks, workingTasks } from "@corbits/tasks-ui";
import type { WorkingTask } from "@corbits/tasks-ui";

import { tenantKeys } from "../query-client";
import { listRoutineActivity } from "./routine-activity";
import type { RoutineActivityItem } from "./routine-activity";

export type BenchActivityQuery =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly channels: readonly Channel[];
      readonly chats: readonly Channel[];
      readonly routines: readonly RoutineActivityItem[];
      readonly workingTasks: readonly WorkingTask[];
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
  // land-hop) announces itself via `CHANNELS_MUTATED_EVENT`; without
  // this, the sidebar's cached listing only catches up on the next
  // unrelated refetch and a fresh workbench is invisible until then.
  useEffect(() => {
    const onMutated = (event: Event) => {
      const detail = (event as CustomEvent<{ tenantId?: string }>).detail;
      if (detail?.tenantId === undefined) return;
      void queryClient.invalidateQueries({
        queryKey: channelsQueryKeyPrefix(detail.tenantId),
      });
    };
    window.addEventListener(CHANNELS_MUTATED_EVENT, onMutated);
    return () => window.removeEventListener(CHANNELS_MUTATED_EVENT, onMutated);
  }, [queryClient]);

  const channelsQuery = useQuery({
    queryKey: tenantKeys.channels(key, "channel"),
    enabled,
    queryFn: () => listChannels(key, "channel"),
  });
  const chatsQuery = useQuery({
    queryKey: tenantKeys.channels(key, "chat"),
    enabled,
    queryFn: () => listChannels(key, "chat"),
  });
  const routinesQuery = useQuery({
    queryKey: tenantKeys.topLevelRuns(key),
    enabled,
    queryFn: () => listRoutineActivity(key),
  });
  const tasksQuery = useQuery({
    queryKey: tenantKeys.tasks(key),
    enabled,
    queryFn: () => listTasks(key),
  });

  if (tenantId === null) return { kind: "empty" };

  for (const query of [channelsQuery, chatsQuery, routinesQuery, tasksQuery]) {
    if (query.isError)
      return { kind: "error", message: errorMessage(query.error) };
  }
  if (
    channelsQuery.data === undefined ||
    chatsQuery.data === undefined ||
    routinesQuery.data === undefined ||
    tasksQuery.data === undefined
  ) {
    return { kind: "loading" };
  }

  return {
    kind: "ready",
    channels: channelsQuery.data,
    chats: chatsQuery.data,
    routines: routinesQuery.data,
    workingTasks: workingTasks(tasksQuery.data),
  };
}
