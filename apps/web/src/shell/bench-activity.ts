// The second column's one data source: everything happening in the
// currently selected bench right now. Channels and chats come from
// `@corbits/chat-ui`'s own validated fetches; running routines come through
// the seam in `./routine-activity.ts`; the signed-in user's in-progress
// tasks come from `@corbits/tasks-ui` (`GET /tasks` is already
// creator-scoped, so every task here is already "mine" — see
// `packages/tasks/src/routes.ts`), resolved to a display name via the same
// invitable-definitions listing the task composer's agent picker uses.
// Notifications have no backing feature in the hub yet, so they are not
// fetched here at all — the column renders an honest empty state for that
// section instead of a query with nowhere to point.

import { useEffect, useState } from "react";
import {
  foldedRunIdsFromChannels,
  listAllChannels,
  listTenantInvitableDefinitions,
} from "@corbits/chat-ui";
import type { Channel } from "@corbits/chat-ui";
import { listTasks, toWorkingTaskViews } from "@corbits/tasks-ui";
import type { WorkingTaskView } from "@corbits/tasks-ui";

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
      readonly workingTasks: readonly WorkingTaskView[];
    };

/** Bench-scoped live activity for the second column, refetched whenever the
 * selected bench changes — nothing here is page-scoped, so a route change
 * alone never triggers a refetch. */
export function useBenchActivity(tenantId: string | null): BenchActivityQuery {
  const [state, setState] = useState<BenchActivityQuery>({ kind: "loading" });

  useEffect(() => {
    if (tenantId === null) {
      setState({ kind: "empty" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    // One all-kinds channels fetch, split client-side, instead of two
    // per-kind fetches: the full list is also exactly what
    // `foldedRunIdsFromChannels` needs to keep the tenant's folded/chat
    // runs (channel hosts + invited agents, which self-anchor like real
    // deployments) out of the "Running" band's deployments listing.
    listAllChannels(tenantId)
      .then(async (allChannels) => {
        const [routines, tasks, definitions] = await Promise.all([
          listRoutineActivity(tenantId, foldedRunIdsFromChannels(allChannels)),
          listTasks(tenantId),
          listTenantInvitableDefinitions(tenantId),
        ]);
        if (cancelled) return;
        const definitionNamesById = new Map(
          definitions.map((definition) => [definition.id, definition.name]),
        );
        setState({
          kind: "ready",
          channels: allChannels.filter((channel) => channel.kind === "channel"),
          chats: allChannels.filter((channel) => channel.kind === "chat"),
          routines,
          workingTasks: toWorkingTaskViews(tasks, definitionNamesById),
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return state;
}
