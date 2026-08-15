// The second column's one data source: everything happening in the
// currently selected bench right now. Channels and chats come from
// `@corbits/chat-ui`'s own validated fetches; running routines come through
// the seam in `./routine-activity.ts`. Notifications have no backing feature
// in the hub yet, so they are not fetched here at all — the column renders
// an honest empty state for that section instead of a query with nowhere
// to point.

import { useEffect, useState } from "react";
import { foldedRunIdsFromChannels, listAllChannels } from "@corbits/chat-ui";
import type { Channel } from "@corbits/chat-ui";

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
        const routines = await listRoutineActivity(
          tenantId,
          foldedRunIdsFromChannels(allChannels),
        );
        if (cancelled) return;
        setState({
          kind: "ready",
          channels: allChannels.filter((channel) => channel.kind === "channel"),
          chats: allChannels.filter((channel) => channel.kind === "chat"),
          routines,
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
